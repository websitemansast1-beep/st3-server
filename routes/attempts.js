const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const gas = require('../services/gasClient');
const { requireAuth, requireRole } = require('../middleware/auth');
const { gradeAttempt } = require('../utils/grading');
const { withLock } = require('../utils/idempotency');
const { publishExamResults, unpublishExamResults, isResultsPublished } = require('../services/resultsService');
const submissionQueue = require('../services/submissionQueue');
const { questionsForStudent, questionsForAdmin } = require('../utils/questions');
const { assertStudentHasUnitAccess } = require('../utils/contentAccess');

const router = express.Router();

// Public-safe view of an attempt for a STUDENT before results are published:
// never leaks score/percentage/passed/answers-with-correctness.
function sanitizeForStudent_(attempt, exam) {
  if (isResultsPublished(exam)) return attempt;
  return {
    id: attempt.id,
    examId: attempt.examId,
    status: attempt.status,
    startTime: attempt.startTime,
    finishTime: attempt.finishTime,
    resultsPublished: false
  };
}

// The server is the only clock that matters: expiresAt is derived from the
// server-recorded startTime + the exam's timer, never from anything the
// client sends. The frontend just displays a countdown to this timestamp.
function withExpiry_(attempt, exam) {
  const minutes = parseInt(exam.timerMinutes, 10) || 0;
  const expiresAt = minutes > 0
    ? new Date(new Date(attempt.startTime).getTime() + minutes * 60000).toISOString()
    : null;
  return { ...attempt, expiresAt, serverTime: new Date().toISOString() };
}

function safeParseJson_(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch (e) { return null; }
}

// POST /api/attempts/start  { examId }
// Idempotent: double-clicking "Start" (or a retried request) never creates
// two attempts — concurrent calls for the same student+exam collapse into
// one, and an already-in-progress attempt is simply returned again.
router.post('/start', requireAuth, requireRole('student'), asyncHandler(async (req, res) => {
  const { examId } = req.body;
  if (!examId) return res.status(400).json({ ok: false, error: 'examId is required' });

  const lockKey = `start:${req.user.id}:${examId}`;
  const result = await withLock(lockKey, async () => {
    const exam = await gas.getById('Exams', examId);
    if (!exam || exam.status !== 'published') {
      return { status: 404, body: { ok: false, error: 'Exam not found or not published' } };
    }
    // Found during a security review: this endpoint checked the exam was
    // published, but never checked the student was actually enrolled in
    // its unit — so any logged-in student could start (and complete) an
    // attempt on ANY published exam site-wide, not just ones they'd been
    // granted access to. GET /exams/:id had the same gap; both are fixed
    // together via the same enrollment check.
    try {
      await assertStudentHasUnitAccess(req, exam);
    } catch (err) {
      return { status: err.status || 403, body: { ok: false, error: err.message } };
    }

    // Questions are fetched in parallel with the prior-attempts lookup
    // (they don't depend on each other), and included directly in this
    // response — the exam page needed BOTH of these anyway (it used to
    // be a separate GET /exams/:id call after this one). One request
    // instead of two for opening an exam.
    const [priorAttempts, questions] = await Promise.all([
      gas.find('Attempts', { examId, studentId: req.user.id }),
      gas.find('Questions', { examId })
    ]);
    const studentQuestions = questionsForStudent(questions, exam);

    // Already have one going? Hand back the SAME attempt instead of
    // starting a second one (this is what makes double-tapping "start"
    // safe, and also what lets the student resume after a refresh).
    const inProgress = priorAttempts.find((a) => a.status === 'in_progress');
    if (inProgress) {
      return { status: 200, body: { ok: true, data: { ...withExpiry_(inProgress, exam), exam, questions: studentQuestions } } };
    }

    const maxAttempts = parseInt(exam.maxAttempts, 10) || 1;
    if (priorAttempts.length >= maxAttempts) {
      return { status: 403, body: { ok: false, error: 'Maximum attempts reached for this exam' } };
    }

    const attempt = await gas.insert('Attempts', {
      examId, studentId: req.user.id, attemptNumber: priorAttempts.length + 1,
      answers: '{}', score: 0, maxScore: 0, percentage: 0, passed: false,
      startTime: new Date().toISOString(), finishTime: '', durationSeconds: 0,
      status: 'in_progress', needsManualGrading: false
    });

    return { status: 201, body: { ok: true, data: { ...withExpiry_(attempt, exam), exam, questions: studentQuestions } } };
  });

  res.status(result.status).json(result.body);
}));

// POST /api/attempts/:id/answers  { answers: { [questionId]: answer } }
// Autosave: merges a batch of answers into the attempt in ONE write. The
// frontend is responsible for batching (collecting several answer changes
// before calling this, not firing a request per click) and for only
// calling this when something actually changed.
router.post('/:id/answers', requireAuth, requireRole('student'), asyncHandler(async (req, res) => {
  const lockKey = `answers:${req.params.id}`;
  const result = await withLock(lockKey, async () => {
    const attempt = await gas.getById('Attempts', req.params.id);
    if (!attempt || attempt.studentId !== req.user.id) {
      return { status: 404, body: { ok: false, error: 'Attempt not found' } };
    }
    if (attempt.status !== 'in_progress') {
      // Not an error — the exam may have just been auto-submitted by the
      // timer while this autosave was in flight. Nothing to save anymore.
      return { status: 200, body: { ok: true, data: { saved: false, status: attempt.status } } };
    }

    const incoming = req.body.answers || {};
    const current = safeParseJson_(attempt.answers) || {};
    const merged = { ...current, ...incoming };

    // Skip the write entirely if nothing actually changed.
    if (JSON.stringify(merged) === JSON.stringify(current)) {
      return { status: 200, body: { ok: true, data: { saved: false, unchanged: true } } };
    }

    await gas.update('Attempts', attempt.id, { answers: JSON.stringify(merged) });
    return { status: 200, body: { ok: true, data: { saved: true } } };
  });

  res.status(result.status).json(result.body);
}));

// POST /api/attempts/:id/submit  { answers: { [questionId]: answer } }
//
// Real queue, not a synchronous write:
//   1. Grade in-process (CPU only — Questions come from the gasClient read
//      cache, so this doesn't wait on a fresh Sheets read in the common case).
//   2. Enqueue the resulting patch. No Sheets call happens on this request.
//   3. Respond immediately with 202 PROCESSING. The student's browser then
//      polls GET /:id/status (with backoff) until the batch processor has
//      flushed this attempt's patch to Sheets.
//
// Idempotent: the attempt id itself is the idempotency key. A double-click,
// a retried request, or two tabs submitting the same attempt all enqueue at
// most once — the queue key is the attempt id, not a client-supplied token,
// so there is nothing for the client to get wrong.
router.post('/:id/submit', requireAuth, requireRole('student'), asyncHandler(async (req, res) => {
  const lockKey = `submit:${req.params.id}`;
  const result = await withLock(lockKey, async () => {
    const attempt = await gas.getById('Attempts', req.params.id);
    if (!attempt || attempt.studentId !== req.user.id) {
      return { status: 404, body: { ok: false, error: 'Attempt not found' } };
    }

    const exam = await gas.getById('Exams', attempt.examId);

    // Already queued or already flushed — never grade/enqueue twice for
    // the same attempt, regardless of how many times this is called.
    const existingStatus = submissionQueue.getStatus(attempt.id);
    if (existingStatus) {
      if (existingStatus.status === 'COMPLETED') {
        return { status: 200, body: { ok: true, data: { id: attempt.id, ...sanitizeForStudent_(existingStatus.result, exam), status: 'COMPLETED' }, alreadySubmitted: true } };
      }
      return { status: 202, body: { ok: true, data: { id: attempt.id, status: existingStatus.status }, alreadySubmitted: true } };
    }

    if (attempt.status !== 'in_progress') {
      // Graded in a previous session (e.g. queue already flushed this
      // before a restart wiped the in-memory status map) — return the
      // stored result rather than re-grading.
      return { status: 200, body: { ok: true, data: sanitizeForStudent_(attempt, exam), alreadySubmitted: true } };
    }

    const questions = await gas.find('Questions', { examId: attempt.examId });
    const answers = req.body.answers || {};

    const { score, maxScore, percentage, needsManualGrading } = gradeAttempt(questions, answers, exam);

    // Server time only — never trust a client-supplied duration/finish time.
    const finishTime = new Date();
    const startTime = new Date(attempt.startTime);
    const durationSeconds = Math.max(0, Math.round((finishTime - startTime) / 1000));
    const passed = percentage >= (parseFloat(exam.passingScore) || 0);

    const patch = {
      answers: JSON.stringify(answers), score, maxScore, percentage, passed,
      finishTime: finishTime.toISOString(), durationSeconds,
      status: needsManualGrading ? 'submitted' : 'graded', needsManualGrading
    };

    submissionQueue.enqueue({
      attemptId: attempt.id,
      patch,
      notifications: [
        {
          audience: 'student', studentId: req.user.id,
          title: 'Exam submitted', message: `Your result for "${exam.title}" is ready.`,
          type: 'exam_result', isRead: false
        },
        {
          audience: 'admin', studentId: req.user.id,
          title: 'New exam attempt', message: `${req.user.name} submitted "${exam.title}"`,
          type: 'exam_attempt', isRead: false
        }
      ],
      // Snapshot used to answer GET /:id/status the instant this batch
      // completes, without an extra Sheets read.
      resultPreview: { ...attempt, ...patch }
    });

    // Deliberately NOT recalculating the whole leaderboard here — that's
    // the "every submit rebuilds all rankings" anti-pattern. Ranking is
    // computed once, when the teacher publishes results (see
    // POST /exam/:examId/publish-results below).
    return { status: 202, body: { ok: true, data: { id: attempt.id, status: 'PROCESSING' } } };
  });

  res.status(result.status).json(result.body);
}));

// GET /api/attempts/:id/status
// Cheap, poll-friendly. Ground truth is: in-memory queue status if we have
// it (fast path, no Sheets call) — otherwise fall back to reading the
// attempt itself (covers a restart that lost the in-memory map but the
// batch had already been flushed before the process went down).
router.get('/:id/status', requireAuth, requireRole('student'), asyncHandler(async (req, res) => {
  const queued = submissionQueue.getStatus(req.params.id);

  if (queued && queued.status === 'PROCESSING') {
    return res.json({ ok: true, data: { id: req.params.id, status: 'PROCESSING' } });
  }

  if (queued && queued.status === 'FAILED') {
    return res.json({ ok: true, data: { id: req.params.id, status: 'FAILED', error: queued.error } });
  }

  if (queued && queued.status === 'COMPLETED') {
    const exam = await gas.getById('Exams', queued.result.examId);
    // Note: sanitizeForStudent_ returns the attempt's own `status` field
    // too (e.g. 'graded'/'submitted') — spread it FIRST, then set the
    // queue-level `status` ('COMPLETED') last so it isn't overwritten.
    return res.json({ ok: true, data: { id: req.params.id, ...sanitizeForStudent_(queued.result, exam), status: 'COMPLETED' } });
  }

  // Nothing in the in-memory map (never queued this run, or restarted
  // after this attempt's batch was already flushed) — read the source of
  // truth directly. One cached Sheets read, safe to poll.
  const attempt = await gas.getById('Attempts', req.params.id);
  if (!attempt || attempt.studentId !== req.user.id) {
    return res.status(404).json({ ok: false, error: 'Attempt not found' });
  }
  if (attempt.status === 'in_progress') {
    return res.json({ ok: true, data: { id: req.params.id, status: 'PROCESSING' } });
  }
  const exam = await gas.getById('Exams', attempt.examId);
  return res.json({ ok: true, data: { id: req.params.id, ...sanitizeForStudent_(attempt, exam), status: 'COMPLETED' } });
}));

// A student's own past attempts for this exam — but still gated by
// resultsPublished, same as every other student-facing result endpoint.
// (Found during security review: this previously returned the raw
// Attempts rows straight from Sheets, including score/percentage/passed,
// even before the teacher published results — a direct bypass of the
// "no score before resultsPublished=true, not even via a manual API call"
// rule that every OTHER result endpoint in this file already enforces.)
router.get('/my/:examId', requireAuth, requireRole('student'), asyncHandler(async (req, res) => {
  const exam = await gas.getById('Exams', req.params.examId);
  const attempts = await gas.find('Attempts', { examId: req.params.examId, studentId: req.user.id });
  res.json({ ok: true, data: exam ? attempts.map((a) => sanitizeForStudent_(a, exam)) : attempts });
}));

router.get('/:id/result', requireAuth, asyncHandler(async (req, res) => {
  const attempt = await gas.getById('Attempts', req.params.id);
  if (!attempt) return res.status(404).json({ ok: false, error: 'Attempt not found' });
  if (req.user.role === 'student' && attempt.studentId !== req.user.id) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }
  if (req.user.role === 'admin') return res.json({ ok: true, data: attempt });

  const exam = await gas.getById('Exams', attempt.examId);
  res.json({ ok: true, data: sanitizeForStudent_(attempt, exam) });
}));

// Admin: all attempts for an exam
router.get('/exam/:examId', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const attempts = await gas.find('Attempts', { examId: req.params.examId });
  res.json({ ok: true, data: attempts });
}));

// GET /api/attempts/exam/:examId/certificates — admin-only. Every
// graded attempt for this exam, joined with the student's name (Attempts
// only stores studentId) — exactly what's needed to render one
// certificate per student without the frontend making N extra calls.
router.get('/exam/:examId/certificates', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const exam = await gas.getById('Exams', req.params.examId);
  if (!exam) return res.status(404).json({ ok: false, error: 'Exam not found' });

  const [attempts, students] = await Promise.all([
    gas.find('Attempts', { examId: req.params.examId }),
    gas.getAll('Students')
  ]);
  const studentsById = new Map(students.map((s) => [s.id, s]));

  const certificates = attempts
    .filter((a) => a.status === 'graded' || a.status === 'submitted')
    .map((a) => {
      const student = studentsById.get(a.studentId);
      return {
        attemptId: a.id,
        studentName: student ? student.name : 'Student',
        percentage: Math.round(parseFloat(a.percentage) || 0),
        passed: String(a.passed) === 'true',
        finishTime: a.finishTime
      };
    })
    .sort((x, y) => y.percentage - x.percentage);

  res.json({ ok: true, data: { exam: { id: exam.id, title: exam.title }, certificates } });
}));

// GET /api/attempts/:id/review — admin-only. Full per-question review:
// each question's text/options/correctAnswer alongside what this specific
// student answered and whether it was right. Reuses gradeAttempt()'s
// breakdown instead of re-deriving correctness logic a second time.
router.get('/:id/review', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const attempt = await gas.getById('Attempts', req.params.id);
  if (!attempt) return res.status(404).json({ ok: false, error: 'Attempt not found' });

  const [exam, questions] = await Promise.all([
    gas.getById('Exams', attempt.examId),
    gas.find('Questions', { examId: attempt.examId })
  ]);
  const answers = safeParseJson_(attempt.answers) || {};
  const { breakdown } = gradeAttempt(questions, answers, exam || {});
  const breakdownById = new Map(breakdown.map((b) => [b.questionId, b]));

  const reviewedQuestions = questionsForAdmin(questions).map((q) => ({
    ...q,
    studentAnswer: answers[q.id] !== undefined ? answers[q.id] : null,
    correct: breakdownById.has(q.id) ? breakdownById.get(q.id).correct : null,
    earned: breakdownById.has(q.id) ? breakdownById.get(q.id).earned : 0
  }));

  res.json({ ok: true, data: { attempt, exam, questions: reviewedQuestions } });
}));

// Rankings (leaderboard). Hidden from students entirely — including via
// direct API call — until the teacher publishes results for this exam.
router.get('/exam/:examId/rankings', requireAuth, asyncHandler(async (req, res) => {
  const exam = await gas.getById('Exams', req.params.examId);
  if (!exam) return res.status(404).json({ ok: false, error: 'Exam not found' });

  if (req.user.role === 'student' && !isResultsPublished(exam)) {
    return res.json({ ok: true, data: [], resultsPublished: false });
  }

  const rankings = await gas.find('Rankings', { examId: req.params.examId });
  rankings.sort((a, b) => (parseFloat(a.rank) || 0) - (parseFloat(b.rank) || 0));

  const students = await gas.getAll('Students');
  const withNames = rankings.map((r) => ({
    ...r,
    studentName: (students.find((s) => s.id === r.studentId) || {}).name || 'Unknown'
  }));

  res.json({ ok: true, data: withNames, resultsPublished: true });
}));

// Admin: publish (compute + reveal) results for an exam. Rankings are
// rebuilt exactly once here, not on every submit.
router.post('/exam/:examId/publish-results', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const exam = await gas.getById('Exams', req.params.examId);
  if (!exam) return res.status(404).json({ ok: false, error: 'Exam not found' });
  await publishExamResults(req.params.examId);
  res.json({ ok: true, data: { published: true } });
}));

// Lets the teacher pull results back out of view — e.g. they published
// too early, or found a grading mistake and want to fix it before
// students see it again. Doesn't touch attempts/scores/rankings, only
// the visibility flag every student-facing read path already checks.
router.post('/exam/:examId/unpublish-results', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const exam = await gas.getById('Exams', req.params.examId);
  if (!exam) return res.status(404).json({ ok: false, error: 'Exam not found' });
  await unpublishExamResults(req.params.examId);
  res.json({ ok: true, data: { published: false } });
}));

module.exports = router;
