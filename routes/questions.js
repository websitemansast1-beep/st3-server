const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const gas = require('../services/gasClient');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
const VALID_TYPES = ['mcq', 'truefalse', 'multi', 'fillblank', 'essay', 'image', 'listening'];

router.use(requireAuth, requireRole('admin'));

router.get('/exam/:examId', asyncHandler(async (req, res) => {
  const questions = await gas.find('Questions', { examId: req.params.examId });
  questions.sort((a, b) => (parseFloat(a.order) || 0) - (parseFloat(b.order) || 0));
  res.json({ ok: true, data: questions });
}));

router.post('/', asyncHandler(async (req, res) => {
  const { examId, type, text, imageUrl, audioUrl, options, correctAnswer, points, order, ttsText, ttsLang, ttsRate } = req.body;
  if (!examId || !type || !text) {
    return res.status(400).json({ ok: false, error: 'examId, type and text are required' });
  }
  if (!VALID_TYPES.includes(type)) {
    return res.status(400).json({ ok: false, error: 'Invalid question type: ' + type });
  }
  // A listening question needs SOMETHING to play — either a real audio
  // file (audioUrl, the old way) or text for the browser's built-in AI
  // voice to read aloud (ttsText, no file upload/hosting needed at all).
  if (type === 'listening' && !audioUrl && !String(ttsText || '').trim()) {
    return res.status(400).json({ ok: false, error: 'Provide either audioUrl or ttsText for a listening question' });
  }

  const question = await gas.insert('Questions', {
    examId, type, text, imageUrl: imageUrl || '', audioUrl: audioUrl || '',
    options: options ? JSON.stringify(options) : '',
    correctAnswer: correctAnswer !== undefined ? JSON.stringify(correctAnswer) : '',
    points: points || 1, order: order || 0,
    ttsText: ttsText || '', ttsLang: ttsLang || '', ttsRate: ttsRate || ''
  });
  res.status(201).json({ ok: true, data: question });
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const patch = { ...req.body };
  if (patch.options !== undefined) patch.options = JSON.stringify(patch.options);
  if (patch.correctAnswer !== undefined) patch.correctAnswer = JSON.stringify(patch.correctAnswer);
  const updated = await gas.update('Questions', req.params.id, patch);
  if (!updated) return res.status(404).json({ ok: false, error: 'Question not found' });
  res.json({ ok: true, data: updated });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const result = await gas.remove('Questions', req.params.id);
  res.json({ ok: true, data: result });
}));

// Manually grade an essay/image answer within an attempt
router.post('/:id/manual-grade', asyncHandler(async (req, res) => {
  const { attemptId, pointsAwarded } = req.body;
  const attempt = await gas.getById('Attempts', attemptId);
  if (!attempt) return res.status(404).json({ ok: false, error: 'Attempt not found' });

  const answers = JSON.parse(attempt.answers || '{}');
  const manualGrades = JSON.parse(attempt.manualGrades || '{}');
  manualGrades[req.params.id] = parseFloat(pointsAwarded) || 0;

  const newScore = (parseFloat(attempt.score) || 0) + (parseFloat(pointsAwarded) || 0);
  const stillNeedsGrading = await checkRemainingManualQuestions(attempt.examId, manualGrades);

  const updated = await gas.update('Attempts', attemptId, {
    score: newScore,
    manualGrades: JSON.stringify(manualGrades),
    needsManualGrading: stillNeedsGrading,
    status: stillNeedsGrading ? 'submitted' : 'graded',
    percentage: attempt.maxScore > 0 ? Math.round((newScore / attempt.maxScore) * 10000) / 100 : 0
  });

  res.json({ ok: true, data: updated });
}));

async function checkRemainingManualQuestions(examId, manualGrades) {
  const questions = await gas.find('Questions', { examId });
  const essayOrImage = questions.filter((q) => q.type === 'essay' || q.type === 'image');
  return essayOrImage.some((q) => manualGrades[q.id] === undefined);
}

// POST /api/questions/bulk — creates many questions for one exam in ONE
// Sheets write, meant for pasting AI-generated question JSON (see the
// "🤖 استورد بالـAI" button in the exam's question panel, which gives the
// admin a copyable prompt for exactly this format). Every question is
// validated BEFORE anything is written — either the whole batch is
// valid and goes in as one insert, or none of it does. No partial/junk
// imports if the pasted JSON has a mistake somewhere in the middle.
router.post('/bulk', asyncHandler(async (req, res) => {
  const { examId, questions } = req.body;
  if (!examId || !Array.isArray(questions) || !questions.length) {
    return res.status(400).json({ ok: false, error: 'examId وقائمة أسئلة (questions) مطلوبين' });
  }
  if (questions.length > 200) {
    return res.status(400).json({ ok: false, error: 'أقصى حد 200 سؤال في المرة الواحدة' });
  }

  const errors = [];
  const prepared = questions.map((q, i) => {
    const n = i + 1;
    const type = q && q.type;
    const text = q && q.text;
    if (!type || !VALID_TYPES.includes(type)) { errors.push(`سؤال ${n}: نوع غير معروف "${type}"`); return null; }
    if (!text || !String(text).trim()) { errors.push(`سؤال ${n}: النص فاضي`); return null; }

    const needsOptions = type === 'mcq' || type === 'multi' || type === 'listening';
    if (needsOptions && (!Array.isArray(q.options) || q.options.length < 2)) {
      errors.push(`سؤال ${n}: لازم اختيارين على الأقل`); return null;
    }
    if (type === 'listening' && !q.audioUrl && !String(q.ttsText || '').trim()) {
      errors.push(`سؤال ${n}: سؤال استماع محتاج ttsText أو audioUrl`); return null;
    }
    if (q.correctAnswer === undefined || q.correctAnswer === null || q.correctAnswer === '') {
      if (type !== 'essay' && type !== 'image') { errors.push(`سؤال ${n}: مفيش correctAnswer`); return null; }
    }
    if (needsOptions && q.correctAnswer !== undefined) {
      const answers = Array.isArray(q.correctAnswer) ? q.correctAnswer : [q.correctAnswer];
      const invalid = answers.some((a) => !q.options.includes(a));
      if (invalid) { errors.push(`سؤال ${n}: الإجابة الصحيحة لازم تكون واحدة من الاختيارات بالظبط`); return null; }
    }

    return {
      examId, type, text: String(text).trim(),
      imageUrl: '', audioUrl: q.audioUrl || '',
      options: q.options ? JSON.stringify(q.options) : '',
      correctAnswer: q.correctAnswer !== undefined ? JSON.stringify(q.correctAnswer) : '',
      points: q.points || 1, order: i,
      ttsText: q.ttsText || '', ttsLang: q.ttsLang || 'en-US', ttsRate: q.ttsRate || '1'
    };
  });

  if (errors.length) {
    return res.status(400).json({ ok: false, error: errors.join(' | ') });
  }

  const inserted = await gas.batchInsert('Questions', prepared);
  res.status(201).json({ ok: true, data: inserted });
}));

module.exports = router;
