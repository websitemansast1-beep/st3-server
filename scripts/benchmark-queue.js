/**
 * benchmark-queue.js
 *
 * Exercises the REAL submissionQueue.js against a MOCKED Google Apps
 * Script layer (there is no live deployed Apps Script endpoint in this
 * environment to test against). This measures the queue's own behavior
 * honestly — batch counts, number of Sheets operations, retry handling —
 * it does NOT measure real Google Sheets/Apps Script latency, which
 * varies with sheet size, quota state, and Google's own load and can only
 * be confirmed against the actual deployed Web App.
 *
 * What IS real here: the queueing logic, the batching logic, the
 * idempotency map, the WAL, and the retry/backoff code — this is the
 * actual backend/services/submissionQueue.js, not a simulation of it.
 * What's mocked: only the two network calls it makes (batchUpdate,
 * batchInsert), replaced with a fixed artificial delay per call.
 *
 * Usage: node backend/scripts/benchmark-queue.js [runs...]
 *   node backend/scripts/benchmark-queue.js 100 250 500 1000
 */

const path = require('path');
const fs = require('fs');

const runs = (process.argv.slice(2).map(Number).filter((n) => n > 0)) .length
  ? process.argv.slice(2).map(Number).filter((n) => n > 0)
  : [100, 250, 500, 1000];

// Isolate each run: fresh WAL file, fresh require cache for the queue
// module (it keeps module-level state), fresh mocked call counters.
const WAL_DIR = path.join(__dirname, '..', '.data', 'bench');
fs.mkdirSync(WAL_DIR, { recursive: true });

// Simulated per-call Apps Script round trip. gasClient.js's own comments
// note real reads run ~1-3s; a batchUpdate/batchInsert write over HTTP to
// a Web App is realistically in a similar ballpark. We use 600ms as a
// representative middle estimate for this benchmark — NOT a measured
// number from a live deployment.
const SIMULATED_GAS_CALL_MS = 600;

async function runOnce(n) {
  const walPath = path.join(WAL_DIR, `wal-${n}.jsonl`);
  try { fs.unlinkSync(walPath); } catch (e) {}

  process.env.SUBMISSION_WAL_PATH = walPath;
  process.env.SUBMISSION_BATCH_SIZE = process.env.BENCH_BATCH_SIZE || '25';
  process.env.SUBMISSION_FLUSH_INTERVAL_MS = '3000';
  process.env.SUBMISSION_MAX_RETRIES = '3';
  process.env.SUBMISSION_RETRY_BASE_DELAY_MS = '500';
  process.env.GAS_ENDPOINT_URL = 'https://example.invalid/mock';
  process.env.GAS_API_KEY = 'bench';
  process.env.JWT_ACCESS_SECRET = 'bench';
  process.env.JWT_REFRESH_SECRET = 'bench';

  // Fresh module instances per run so stats/queue state don't leak across runs.
  delete require.cache[require.resolve('../config/config')];
  delete require.cache[require.resolve('../services/gasClient')];
  delete require.cache[require.resolve('../services/submissionQueue')];

  const gas = require('../services/gasClient');
  let sheetsCalls = 0;
  let failNextCall = false; // toggled on to exercise the retry path once per run

  gas.batchUpdate = async (table, patches) => {
    sheetsCalls += 1;
    await sleep(SIMULATED_GAS_CALL_MS);
    if (failNextCall) { failNextCall = false; throw new Error('simulated transient Sheets error'); }
    return patches;
  };
  gas.batchInsert = async (table, records) => {
    sheetsCalls += 1;
    await sleep(SIMULATED_GAS_CALL_MS);
    return records;
  };

  const queue = require('../services/submissionQueue');

  // Exercise the retry path exactly once during this run, on some
  // mid-run batch, to prove failed batches are retried and eventually
  // marked correctly rather than silently dropped.
  failNextCall = true;

  const start = Date.now();
  const attemptIds = [];
  for (let i = 0; i < n; i++) {
    const attemptId = `bench-attempt-${n}-${i}`;
    attemptIds.push(attemptId);
    queue.enqueue({
      attemptId,
      patch: { score: 8, maxScore: 10, percentage: 80, status: 'graded' },
      notifications: [{ audience: 'student', studentId: `s${i}`, title: 'x', message: 'x', type: 'exam_result', isRead: false }],
      resultPreview: { id: attemptId, examId: 'exam-1', percentage: 80 }
    });
    // A real submit burst isn't a single synchronous for-loop tick — give
    // the event loop a chance every so often so this looks like concurrent
    // HTTP requests arriving, not one blocking loop.
    if (i % 50 === 0) await sleep(0);
  }

  // Wait for every attempt to leave PROCESSING.
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    const pendingCount = attemptIds.filter((id) => {
      const s = queue.getStatus(id);
      return !s || s.status === 'PROCESSING';
    }).length;
    if (pendingCount === 0) break;
    await sleep(50);
  }

  const totalMs = Date.now() - start;
  const completed = attemptIds.filter((id) => queue.getStatus(id).status === 'COMPLETED').length;
  const failed = attemptIds.filter((id) => queue.getStatus(id).status === 'FAILED').length;
  const stats = queue.getStats();

  return {
    n, totalMs, completed, failed,
    batchSize: queue.BATCH_SIZE,
    batchesFlushed: stats.batchesFlushed,
    sheetsWriteCalls: sheetsCalls,
    retries: stats.totalRetries
  };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  console.log(`Simulated per-Sheets-call latency: ${SIMULATED_GAS_CALL_MS}ms (mock, not a live measurement)\n`);
  const results = [];
  for (const n of runs) {
    const r = await runOnce(n);
    results.push(r);
    console.log(
      `n=${r.n}\ttotal=${r.totalMs}ms\tcompleted=${r.completed}\tfailed=${r.failed}\t` +
      `batchSize=${r.batchSize}\tbatches=${r.batchesFlushed}\tsheetsCalls=${r.sheetsWriteCalls}\tretries=${r.retries}`
    );
  }

  console.log('\n| Submissions | Batch size | Batches | Sheets ops | Retries | Wall time | Naive (1 write/student) |');
  console.log('|---|---|---|---|---|---|---|');
  for (const r of results) {
    const naiveMs = r.n * SIMULATED_GAS_CALL_MS;
    console.log(`| ${r.n} | ${r.batchSize} | ${r.batchesFlushed} | ${r.sheetsWriteCalls} | ${r.retries} | ${(r.totalMs / 1000).toFixed(1)}s | ${(naiveMs / 1000).toFixed(1)}s |`);
  }

  const anyFailed = results.some((r) => r.failed > 0);
  if (anyFailed) {
    console.log('\nWARNING: some submissions ended FAILED after exhausting retries — investigate before trusting this run.');
    process.exitCode = 1;
  }
})();
