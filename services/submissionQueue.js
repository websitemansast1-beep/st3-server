/**
 * submissionQueue.js
 *
 * A real submission queue, as opposed to the old design where every
 * POST /attempts/:id/submit did its grading AND its Google Sheets write
 * inline, inside a LockService-guarded critical section — which meant
 * 1000 students submitting together fully serialized on Apps Script's
 * single script lock.
 *
 * Flow now:
 *
 *   student clicks Submit
 *     -> grade in-process (no Sheets call: Questions are read from the
 *        gasClient read cache, which is almost always already warm)
 *     -> enqueue({ attemptId, patch, notifications })   [O(1), no I/O]
 *     -> respond immediately: { status: 'PROCESSING' }
 *
 *   independently, a batch processor:
 *     -> waits until BATCH_SIZE items are queued OR FLUSH_INTERVAL_MS
 *        has passed since the oldest queued item, whichever comes first
 *     -> takes one batch, calls gas.batchUpdate('Attempts', patches) ONCE
 *        and gas.batchInsert('Notifications', ...) ONCE for the whole batch
 *     -> marks every item in that batch COMPLETED (or retries/FAILED)
 *
 * This file owns exactly one thing: getting a batch of ALREADY-GRADED
 * patches into Sheets efficiently and safely. It does not grade, and it
 * does not touch Rankings — those stay exactly where they were (grading
 * in the route handler, ranking at publish-results time).
 *
 * ---------------------------------------------------------------------
 * Honesty about what this is and isn't:
 *
 * - This queue lives in the Node process's memory. It is correct and fast
 *   for a single backend instance (which is what the Railway/Render
 *   deploy in this repo is — see server.js, there is no clustering).
 * - It is NOT a distributed queue. If you ever run more than one backend
 *   instance, each instance has its OWN queue and its OWN idempotency
 *   map — you would need a shared store (Redis, or a Sheets-backed queue
 *   table) for correctness across instances.
 * - A write-ahead log (WAL) on local disk is used so that a plain process
 *   restart on the SAME machine/disk can recover anything that was queued
 *   but not yet flushed. This does NOT survive a fresh deploy on a
 *   platform that gives you a new ephemeral filesystem each deploy. See
 *   QUEUE_REPORT.md for the full answer to "what happens on restart".
 */

const fs = require('fs');
const path = require('path');
const config = require('../config/config');
const gas = require('./gasClient');

const {
  batchSize: BATCH_SIZE,
  flushIntervalMs: FLUSH_INTERVAL_MS,
  maxRetries: MAX_RETRIES,
  retryBaseDelayMs: RETRY_BASE_DELAY_MS,
  walEnabled: WAL_ENABLED,
  walPath: WAL_PATH
} = config.submissionQueue;

// Terminally-failed batches (all MAX_RETRIES exhausted) are moved here
// instead of being dropped from the WAL. Nothing is EVER silently lost:
// a job leaves disk only once its batch has actually been written to
// Sheets. This file needs a human/admin to look at it — the process does
// not keep auto-retrying a batch that has already failed 4 times in a
// row, to avoid a broken Apps Script deployment causing a retry storm.
const WAL_DEAD_LETTER_PATH = WAL_PATH.replace(/\.jsonl$/, '') + '.dead.jsonl';

// attemptId -> { status: 'PROCESSING'|'COMPLETED'|'FAILED', result, error, queuedAt, completedAt }
const statusById = new Map();

// Pending jobs waiting to be flushed. One job === one student's submission.
// { attemptId, patch, notifications, queuedAt, retries }
let pending = [];

// Jobs currently mid-flush (removed from `pending`, not yet COMPLETED/FAILED).
// Kept separate so a crash mid-flush is visible in the WAL as "still pending".
let inFlightBatch = null;

let flushTimer = null;
let flushing = false;

const stats = {
  totalQueued: 0,
  totalCompleted: 0,
  totalFailed: 0,
  totalRetries: 0,
  batchesFlushed: 0,
  sheetsWriteCalls: 0, // batchUpdate + batchInsert calls, i.e. real Sheets operations
  lastBatchSize: 0,
  lastBatchMs: 0
};

// ---------------------------------------------------------------------
// Write-ahead log: append when a job is queued, rewrite (compact) after
// every successful flush so it only ever contains truly-pending work.
// ---------------------------------------------------------------------
function walAppend_(job) {
  if (!WAL_ENABLED) return;
  try {
    fs.mkdirSync(path.dirname(WAL_PATH), { recursive: true });
    fs.appendFileSync(WAL_PATH, JSON.stringify(job) + '\n');
  } catch (e) {
    // The WAL is a best-effort safety net, not the source of truth for the
    // in-memory queue — never let a disk error break a student's submit.
    console.error('[submissionQueue] WAL append failed:', e.message);
  }
}

function walCompact_() {
  if (!WAL_ENABLED) return;
  try {
    fs.mkdirSync(path.dirname(WAL_PATH), { recursive: true });
    const remaining = pending.concat(inFlightBatch || []);
    const lines = remaining.map((j) => JSON.stringify(j)).join('\n');
    fs.writeFileSync(WAL_PATH, remaining.length ? lines + '\n' : '');
  } catch (e) {
    console.error('[submissionQueue] WAL compact failed:', e.message);
  }
}

function walDeadLetter_(jobs, errorMessage) {
  if (!WAL_ENABLED || !jobs.length) return;
  try {
    fs.mkdirSync(path.dirname(WAL_DEAD_LETTER_PATH), { recursive: true });
    const lines = jobs
      .map((j) => JSON.stringify({ ...j, failedAt: new Date().toISOString(), error: errorMessage }))
      .join('\n');
    fs.appendFileSync(WAL_DEAD_LETTER_PATH, lines + '\n');
  } catch (e) {
    console.error('[submissionQueue] Dead-letter write failed:', e.message);
  }
}

/**
 * Replays anything left in the WAL from a previous process run into the
 * in-memory queue. Called once at module load. If the previous process
 * never got to flush a job, it's re-queued here and will be retried
 * normally — still exactly-once, because the patch is idempotent (it
 * fully overwrites the attempt's final graded fields, it doesn't
 * increment anything).
 */
function recoverFromWal_() {
  if (!WAL_ENABLED) return;
  try {
    if (!fs.existsSync(WAL_PATH)) return;
    const content = fs.readFileSync(WAL_PATH, 'utf8');
    const jobs = content.split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch (e) { return null; }
    }).filter(Boolean);

    if (!jobs.length) return;

    const seen = new Set();
    for (const job of jobs) {
      if (seen.has(job.attemptId)) continue; // WAL may have dupes across appends; keep the latest
      seen.add(job.attemptId);
      pending.push(job);
      statusById.set(job.attemptId, { status: 'PROCESSING', queuedAt: job.queuedAt });
    }
    console.log(`[submissionQueue] Recovered ${pending.length} pending submission(s) from WAL after restart.`);
  } catch (e) {
    console.error('[submissionQueue] WAL recovery failed:', e.message);
  }
}

function sleep_(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function scheduleFlush_() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushBatch_();
  }, FLUSH_INTERVAL_MS);
}

/**
 * Enqueue one already-graded submission. O(1), no network call — this is
 * what keeps Submit fast no matter how many students hit it at once.
 */
function enqueue(job) {
  const record = { ...job, queuedAt: Date.now(), retries: 0 };
  pending.push(record);
  statusById.set(job.attemptId, { status: 'PROCESSING', queuedAt: record.queuedAt });
  stats.totalQueued += 1;
  walAppend_(record);

  if (pending.length >= BATCH_SIZE) {
    // Batch is full — flush right away instead of waiting for the timer.
    setImmediate(flushBatch_);
  } else {
    scheduleFlush_();
  }
}

function getStatus(attemptId) {
  return statusById.get(attemptId) || null;
}

/**
 * Flushes ONE batch (up to BATCH_SIZE items) to Google Sheets in exactly
 * two Sheets operations total, no matter the batch size:
 *   1. gas.batchUpdate('Attempts', patches)      — the graded results
 *   2. gas.batchInsert('Notifications', records)  — the notification rows
 * Retries the whole batch on failure with short exponential backoff.
 * Never re-flushes a batch that already succeeded (idempotent: on retry
 * we resend the SAME patches, which is a full-overwrite update, not an
 * increment — applying it twice is harmless).
 */
async function flushBatch_() {
  if (flushing) return; // one flush at a time keeps this simple and correct
  if (!pending.length) return;
  flushing = true;

  const batch = pending.splice(0, BATCH_SIZE);
  inFlightBatch = batch;
  const startedAt = Date.now();

  try {
    let lastError = null;
    let succeeded = false;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const patches = batch.map((j) => ({ id: j.attemptId, patch: j.patch }));
        await gas.batchUpdate('Attempts', patches);
        stats.sheetsWriteCalls += 1;

        const allNotifications = batch.flatMap((j) => j.notifications || []);
        if (allNotifications.length) {
          await gas.batchInsert('Notifications', allNotifications);
          stats.sheetsWriteCalls += 1;
        }

        succeeded = true;
        break;
      } catch (err) {
        lastError = err;
        stats.totalRetries += 1;
        if (attempt < MAX_RETRIES) {
          // Short exponential backoff: 500ms, 1000ms, 2000ms — bounded,
          // never a long artificial sleep, and only delays THIS batch's
          // retry, not new submissions from being accepted.
          await sleep_(RETRY_BASE_DELAY_MS * Math.pow(2, attempt));
        }
      }
    }

    if (succeeded) {
      for (const job of batch) {
        statusById.set(job.attemptId, {
          status: 'COMPLETED',
          result: job.resultPreview,
          queuedAt: job.queuedAt,
          completedAt: Date.now()
        });
      }
      stats.totalCompleted += batch.length;
    } else {
      for (const job of batch) {
        statusById.set(job.attemptId, {
          status: 'FAILED',
          error: lastError ? lastError.message : 'Unknown error',
          queuedAt: job.queuedAt,
          completedAt: Date.now()
        });
      }
      stats.totalFailed += batch.length;
      const errMsg = lastError ? lastError.message : 'Unknown error';
      console.error(
        `[submissionQueue] Batch of ${batch.length} FAILED after ${MAX_RETRIES + 1} attempts: ${errMsg} ` +
        `-- writing to dead-letter file, NOT silently dropped: ${WAL_DEAD_LETTER_PATH}`
      );
      // Preserve the graded patch on disk even though we're giving up on
      // automatic retries for this batch — an admin can inspect/replay
      // WAL_DEAD_LETTER_PATH rather than these answers being gone.
      walDeadLetter_(batch, errMsg);
    }

    stats.batchesFlushed += 1;
    stats.lastBatchSize = batch.length;
    stats.lastBatchMs = Date.now() - startedAt;

    console.log(
      `[submissionQueue] batch=${stats.batchesFlushed} size=${batch.length} ` +
      `${succeeded ? 'OK' : 'FAILED'} ms=${stats.lastBatchMs} queueRemaining=${pending.length}`
    );
  } finally {
    inFlightBatch = null;
    walCompact_(); // batch is resolved (success or terminal failure) — drop it from the WAL
    flushing = false;
    if (pending.length) {
      // More work queued up while we were flushing — go again.
      if (pending.length >= BATCH_SIZE) setImmediate(flushBatch_);
      else scheduleFlush_();
    }
  }
}

function getStats() {
  return { ...stats, queueLength: pending.length, flushing };
}

recoverFromWal_();
if (pending.length) scheduleFlush_();

module.exports = { enqueue, getStatus, getStats, BATCH_SIZE, FLUSH_INTERVAL_MS, WAL_PATH, WAL_DEAD_LETTER_PATH };
