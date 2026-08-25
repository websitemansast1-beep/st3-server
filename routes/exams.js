const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const gas = require('../services/gasClient');
const { requireAuth, requireRole } = require('../middleware/auth');
const { questionsForStudent, questionsForAdmin } = require('../utils/questions');
const { assertStudentHasUnitAccess } = require('../utils/contentAccess');

const router = express.Router();

router.get('/unit/:unitId', requireAuth, asyncHandler(async (req, res) => {
  const exams = await gas.find('Exams', { unitId: req.params.unitId });
  exams.sort((a, b) => (parseFloat(a.order) || 0) - (parseFloat(b.order) || 0));
  res.json({ ok: true, data: exams.filter((e) => req.user.role === 'admin' || e.status === 'published') });
}));

router.get('/:id', requireAuth, asyncHandler(async (req, res) => {
  const exam = await gas.getById('Exams', req.params.id);
  if (!exam) return res.status(404).json({ ok: false, error: 'Exam not found' });
  await assertStudentHasUnitAccess(req, exam);

  // Students never receive correctAnswer in the payload
  if (req.user.role === 'student') {
    const questions = await gas.find('Questions', { examId: exam.id });
    return res.json({ ok: true, data: { ...exam, questions: questionsForStudent(questions, exam) } });
  }

  const questions = await gas.find('Questions', { examId: exam.id });
  res.json({ ok: true, data: { ...exam, questions: questionsForAdmin(questions) } });
}));

// NOTE: exam submission now lives entirely in routes/attempts.js
// (POST /api/attempts/start then POST /api/attempts/:id/submit). That flow
// is server-time-authoritative (startTime/duration come from the server,
// never the client) and idempotent (double-submit replays the same stored
// result instead of grading twice or creating a duplicate row). This route
// used to duplicate that logic inline — including trusting a client-sent
// `timeTaken` for duration and returning the score/rank to the student
// immediately, bypassing results-publishing — so it has been removed
// rather than kept as a second, divergent path.

// GET /api/exams?courseId=xxx  (student sees exams for a specific unit)
router.get('/', requireAuth, requireRole('student'), asyncHandler(async (req, res) => {
  const { courseId } = req.query;
  if (!courseId) {
    return res.status(400).json({ ok: false, error: 'courseId is required' });
  }

  const student = await gas.getById('Students', req.user.id);
  const unitIds = (student.unitIds || '').split(',').filter(Boolean);
  if (!unitIds.includes(courseId)) {
    return res.status(403).json({ ok: false, error: 'Access denied' });
  }

  const exams = await gas.find('Exams', { unitId: courseId });
  const attempts = await gas.find('Attempts', { studentId: req.user.id });

  const enriched = exams.map((e) => {
    // graded/submitted = finished attempts (the old 'completed' status no
    // longer gets written by anything — attempts.js writes graded/submitted)
    const sAttempts = attempts.filter((a) => a.examId === e.id && (a.status === 'graded' || a.status === 'submitted'));
    const lastAttempt = sAttempts.sort((a, b) => new Date(b.finishTime) - new Date(a.finishTime))[0];
    const published = String(e.resultsPublished) === 'true';
    const score = published && lastAttempt ? Math.round(parseFloat(lastAttempt.percentage) || 0) : null;
    return {
      id: e.id,
      title: e.title,
      questionCount: (e.questionIds || '').split(',').filter(Boolean).length,
      duration: e.timerMinutes || 0,
      type: e.type || 'متعدد',
      available: true,
      completed: sAttempts.length > 0,
      resultsPublished: published,
      score,
      result: score != null ? { score } : null
    };
  });

  res.json({ exams: enriched });
}));

// GET /api/exams/admin/all  (admin: flat list of every exam, for filters/dropdowns)
router.get('/admin/all', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const exams = await gas.getAll('Exams');
  res.json({ ok: true, data: exams });
}));

router.use(requireAuth, requireRole('admin'));

router.post('/', asyncHandler(async (req, res) => {
  const {
    unitId, title, description, timerMinutes, maxAttempts, passingScore,
    shuffleQuestions, negativeMarking, negativeMarkValue, order
  } = req.body;
  if (!unitId || !title) return res.status(400).json({ ok: false, error: 'unitId and title are required' });

  const exam = await gas.insert('Exams', {
    unitId, title, description: description || '',
    timerMinutes: timerMinutes || 0, maxAttempts: maxAttempts || 1,
    passingScore: passingScore || 50, shuffleQuestions: !!shuffleQuestions,
    negativeMarking: !!negativeMarking, negativeMarkValue: negativeMarkValue || 0,
    status: 'draft', order: order || 0, resultsPublished: false
  });
  res.status(201).json({ ok: true, data: exam });
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const updated = await gas.update('Exams', req.params.id, req.body);
  if (!updated) return res.status(404).json({ ok: false, error: 'Exam not found' });
  res.json({ ok: true, data: updated });
}));

router.post('/:id/publish', asyncHandler(async (req, res) => {
  res.json({ ok: true, data: await gas.update('Exams', req.params.id, { status: 'published' }) });
}));

router.post('/:id/hide', asyncHandler(async (req, res) => {
  res.json({ ok: true, data: await gas.update('Exams', req.params.id, { status: 'hidden' }) });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const questions = await gas.find('Questions', { examId: req.params.id });
  await Promise.all(questions.map((q) => gas.remove('Questions', q.id)));
  const result = await gas.remove('Exams', req.params.id);
  res.json({ ok: true, data: result });
}));

module.exports = router;
