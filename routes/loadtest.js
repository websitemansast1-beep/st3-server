const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const gas = require('../services/gasClient');
const { requireAuth, requireRole } = require('../middleware/auth');
const { gradeAttempt } = require('../utils/grading');
const submissionQueue = require('../services/submissionQueue');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

const MAX_LOADTEST_COUNT = 500;

/**
 * Simulates real students taking a real exam, entirely from this one admin
 * page — no need to open the code N times in N browser tabs.
 *
 * The account/attempt SETUP (creating students, activating codes, opening
 * attempts) is done with exactly 4 Sheets calls total no matter the count
 * (generateCodes + batchInsert Students + batchUpdate Codes + batchInsert
 * Attempts) — NOT one call per student. Every write to Apps Script takes
 * the same global script lock (see Code.gs), so doing this one-by-one for
 * 100+ students meant 300+ writes fully serialized behind that single lock
 * — that was the actual cause of "بيدي مشاكل لما بعمل ميت حساب", not the
 * count itself. Grading and the final submit still exercise the real
 * per-student path: each answer is graded individually and submitted
 * through the SAME submissionQueue real student submissions go through
 * (which does its own batching on the way to Sheets).
 *
 * Deliberately in-memory (jobs Map) — fine for a single persistent backend
 * process (this platform runs on Railway); state is lost on a restart, so
 * clean up a job before redeploying if you haven't already.
 */
const jobs = new Map(); // jobId -> job state

function safeParseJson_(value, fallback) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch (e) { return fallback; }
}

// Builds a plausible answer for one question: correct ~65% of the time,
// something else the rest — so the run produces a realistic spread of
// scores (useful for actually eyeballing the leaderboard/results screens),
// not just a wall of 100%s.
function simulateAnswer_(q) {
  const correctChance = 0.65;
  const isCorrectAttempt = Math.random() < correctChance;

  switch (q.type) {
    case 'mcq':
    case 'listening':
    case 'truefalse': {
      const correct = safeParseJson_(q.correctAnswer, null);
      if (isCorrectAttempt || correct === null) return correct;
      const options = safeParseJson_(q.options, []);
      const wrongOptions = options.filter((o) => String(o) !== String(correct));
      return wrongOptions.length ? wrongOptions[Math.floor(Math.random() * wrongOptions.length)] : correct;
    }
    case 'multi': {
      const correct = safeParseJson_(q.correctAnswer, []);
      if (isCorrectAttempt) return correct;
      const options = safeParseJson_(q.options, []);
      return options.filter(() => Math.random() < 0.5);
    }
    case 'fillblank': {
      const parsed = safeParseJson_(q.correctAnswer, '');
      const acceptable = Array.isArray(parsed) ? parsed[0] : parsed;
      return isCorrectAttempt ? acceptable : 'إجابة تجريبية غلط';
    }
    case 'essay':
    case 'image':
      return undefined; // left for manual grading either way
    default:
      return undefined;
  }
}

async function runJob_(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;
  try {
    const [exam, questions] = await Promise.all([
      gas.getById('Exams', job.examId),
      gas.find('Questions', { examId: job.examId })
    ]);
    if (!exam) throw new Error('الامتحان غير موجود');

    // Everything below is deliberately done in exactly 4 Sheets calls total
    // (generateCodes, batchInsert Students, batchUpdate Codes, batchInsert
    // Attempts) no matter whether count is 20 or 500 — NOT one call per
    // simulated student. Every write to Apps Script takes the same global
    // script lock (see Code.gs), so 100 accounts done one-by-one means 300
    // individual writes fully serialized behind that one lock — that's
    // what was actually causing the timeouts, not the count itself.
    const now = new Date().toISOString();
    const codes = await gas.generateCodes(exam.unitId, job.total, job.prefix);
    codes.forEach((c, i) => { job.items[i].codeId = c.id; job.items[i].code = c.code; });

    const students = await gas.batchInsert('Students', codes.map((c, i) => ({
      name: `طالب تجريبي ${i + 1}`, phone: '', guardianPhone: '',
      code: c.code, unitIds: exam.unitId, createdAt: now, lastLoginAt: now,
      loadTestJobId: jobId // lets cleanup remove every row this job made in ONE call per table
    })));
    students.forEach((s, i) => { job.items[i].studentId = s.id; job.items[i].studentName = s.name; });

    await gas.batchUpdate('Codes', codes.map((c, i) => ({
      id: c.id,
      patch: {
        status: 'active', studentId: students[i].id, studentName: students[i].name,
        activationDate: now, loadTestJobId: jobId
      }
    })));

    const attempts = await gas.batchInsert('Attempts', students.map((s) => ({
      examId: exam.id, studentId: s.id, attemptNumber: 1,
      answers: '{}', score: 0, maxScore: 0, percentage: 0, passed: false,
      startTime: now, finishTime: '', durationSeconds: 0,
      status: 'in_progress', needsManualGrading: false, loadTestJobId: jobId
    })));

    // From here it's all local CPU work (grading) plus submissionQueue,
    // which already batches its own writes — so this loop doesn't add
    // any further per-student Sheets calls.
    attempts.forEach((attempt, i) => {
      const item = job.items[i];
      try {
        const answers = {};
        questions.forEach((q) => { answers[q.id] = simulateAnswer_(q); });

        const { score, maxScore, percentage, needsManualGrading } = gradeAttempt(questions, answers, exam);
        const passed = percentage >= (parseFloat(exam.passingScore) || 0);
        const finishTime = new Date();
        const durationSeconds = Math.max(1, Math.round((finishTime - new Date(now)) / 1000));

        const patch = {
          answers: JSON.stringify(answers), score, maxScore, percentage, passed,
          finishTime: finishTime.toISOString(), durationSeconds,
          status: needsManualGrading ? 'submitted' : 'graded', needsManualGrading
        };

        submissionQueue.enqueue({
          attemptId: attempt.id,
          patch,
          notifications: [],
          resultPreview: { ...attempt, ...patch }
        });

        item.attemptId = attempt.id;
        item.percentage = percentage;
        item.passed = passed;
        item.status = 'done';
      } catch (err) {
        item.status = 'error';
        item.error = err.message || String(err);
      } finally {
        job.completed += 1;
      }
    });

    const done = job.items.filter((it) => it.status === 'done');
    const errored = job.items.filter((it) => it.status === 'error');
    const avg = done.length ? done.reduce((s, it) => s + it.percentage, 0) / done.length : 0;
    const passCount = done.filter((it) => it.passed).length;

    job.summary = {
      requested: job.total,
      succeeded: done.length,
      failed: errored.length,
      averagePercentage: Math.round(avg * 100) / 100,
      passRate: done.length ? Math.round((passCount / done.length) * 10000) / 100 : 0,
      tookMs: Date.now() - job.startedAtMs
    };
  } catch (err) {
    job.fatalError = err.message || String(err);
  } finally {
    job.running = false;
    job.finishedAt = new Date().toISOString();
  }
}

// POST /api/loadtest/run  { examId, count }
router.post('/run', asyncHandler(async (req, res) => {
  const { examId, count } = req.body;
  if (!examId) return res.status(400).json({ ok: false, error: 'examId is required' });
  const n = Math.min(parseInt(count, 10) || 0, MAX_LOADTEST_COUNT);
  if (n <= 0) return res.status(400).json({ ok: false, error: `count must be a positive number (max ${MAX_LOADTEST_COUNT})` });

  const exam = await gas.getById('Exams', examId);
  if (!exam) return res.status(404).json({ ok: false, error: 'Exam not found' });

  const jobId = 'lt_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const prefix = 'TEST' + Date.now().toString(36).toUpperCase().slice(-4);
  const job = {
    id: jobId, examId, examTitle: exam.title, unitId: exam.unitId, prefix,
    total: n, completed: 0, running: true, startedAt: new Date().toISOString(),
    startedAtMs: Date.now(), finishedAt: null, summary: null, fatalError: null,
    items: Array.from({ length: n }, () => ({ status: 'pending' }))
  };
  jobs.set(jobId, job);

  runJob_(jobId); // deliberately not awaited — this responds immediately, frontend polls status

  res.status(202).json({ ok: true, data: { jobId, total: n, examTitle: exam.title } });
}));

// GET /api/loadtest/status/:jobId — poll while running, gives the final summary once done
router.get('/status/:jobId', asyncHandler(async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ ok: false, error: 'Job not found (server may have restarted)' });
  res.json({
    ok: true,
    data: {
      id: job.id, examTitle: job.examTitle, total: job.total, completed: job.completed,
      running: job.running, summary: job.summary, fatalError: job.fatalError,
      // Only send finished items to keep the payload light while it's running
      items: job.items.filter((it) => it.status !== 'pending')
    }
  });
}));

// DELETE /api/loadtest/:jobId — removes every student/code/attempt this run
// created, in exactly 3 Sheets calls (one replaceMatching per table on
// loadTestJobId) no matter the count — same batching principle as the run
// itself, so cleanup doesn't hit the same lock contention undoing what it
// just fixed.
router.delete('/:jobId', asyncHandler(async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ ok: false, error: 'Job not found (server may have restarted)' });
  if (job.running) return res.status(409).json({ ok: false, error: 'لسه الاختبار شغال، استنى لحد ما يخلص الأول' });

  await Promise.all([
    gas.replaceMatching('Attempts', { loadTestJobId: req.params.jobId }, []),
    gas.replaceMatching('Students', { loadTestJobId: req.params.jobId }, []),
    gas.replaceMatching('Codes', { loadTestJobId: req.params.jobId }, [])
  ]);

  jobs.delete(req.params.jobId);
  res.json({ ok: true, data: { cleaned: true } });
}));

module.exports = router;
