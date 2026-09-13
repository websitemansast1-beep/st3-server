const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const gas = require('../services/gasClient'); // Drive only (deleteFile in the cascade delete below)
const db = require('../services/firestoreClient');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

function safeParseJson_(value) {
  if (!value) return [];
  try { return JSON.parse(value); } catch (e) { return []; }
}

// GET /api/units?courseId=xxx  (student course detail + lessons)
router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const { courseId } = req.query;

  // If courseId is provided, return that specific unit with its content
  if (courseId) {
    const unit = await db.getById('Units', courseId);
    if (!unit || unit.status !== 'published') {
      return res.status(404).json({ ok: false, error: 'Unit not found' });
    }

    // Students must have access
    if (req.user.role === 'student') {
      const student = await db.getById('Students', req.user.id);
      const unitIds = (student.unitIds || '').split(',').filter(Boolean);
      if (!unitIds.includes(courseId)) {
        return res.status(403).json({ ok: false, error: 'Access denied' });
      }
    }

    let [videos, exams, presentations, lessons] = await Promise.all([
      db.find('Videos', { unitId: courseId }),
      db.find('Exams', { unitId: courseId }),
      db.find('Presentations', { unitId: courseId }),
      db.find('Lessons', { unitId: courseId })
    ]);

    if (req.user.role !== 'admin') {
      videos = videos.filter((v) => v.status === 'published');
      exams = exams.filter((e) => e.status === 'published');
      presentations = presentations.filter((p) => p.status === 'published');
      lessons = lessons.filter((l) => l.status === 'published');
    }
    videos.sort((a, b) => (parseFloat(a.order) || 0) - (parseFloat(b.order) || 0));
    exams.sort((a, b) => (parseFloat(a.order) || 0) - (parseFloat(b.order) || 0));
    presentations.sort((a, b) => (parseFloat(a.order) || 0) - (parseFloat(b.order) || 0));
    lessons.sort((a, b) => (parseFloat(a.order) || 0) - (parseFloat(b.order) || 0));

    // Mark which videos this student has already finished
    let watchedVideoIds = new Set();
    if (req.user.role === 'student') {
      const progress = await db.find('VideoProgress', { studentId: req.user.id });
      watchedVideoIds = new Set(progress.filter((p) => p.status === 'finished').map((p) => p.videoId));
    }

    // Group videos/presentations by the real Lesson they belong to
    // (lessonId). Anything with no lessonId (old content, or content added
    // outside a lesson) falls into one trailing "General" group so nothing
    // ever disappears from the accordion.
    const byLesson = (arr, lessonId) => arr.filter((item) => (item.lessonId || '') === lessonId);
    const toVideoCard = (v) => ({
      id: v.id, title: v.title,
      duration: v.durationSeconds ? Math.round(v.durationSeconds / 60) + ' د' : '',
      watched: watchedVideoIds.has(v.id)
    });
    const toPresentationCard = (p) => ({ id: p.id, title: p.title, slideCount: p.slideCount || 0 });

    const lessonGroups = lessons.map((l) => ({
      id: l.id,
      title: l.title,
      content: l.content || '', // lesson text/notes, shown above its videos
      videos: byLesson(videos, l.id).map(toVideoCard),
      presentations: byLesson(presentations, l.id).map(toPresentationCard),
      exams: exams.filter((e) => (e.lessonId || '') === l.id).map((e) => ({ id: e.id, title: e.title }))
    }));

    const groupedVideoIds = new Set(lessons.map((l) => l.id));
    const looseVideos = videos.filter((v) => !groupedVideoIds.has(v.lessonId || ''));
    const loosePresentations = presentations.filter((p) => !groupedVideoIds.has(p.lessonId || ''));
    const looseExams = exams.filter((e) => !groupedVideoIds.has(e.lessonId || ''));
    if (looseVideos.length || loosePresentations.length || looseExams.length) {
      lessonGroups.push({
        id: '',
        title: lessons.length ? 'محتوى عام' : unit.title,
        content: '',
        videos: looseVideos.map(toVideoCard),
        presentations: loosePresentations.map(toPresentationCard),
        exams: looseExams.map((e) => ({ id: e.id, title: e.title }))
      });
    }

    return res.json({
      id: unit.id,
      title: unit.title,
      description: unit.description || '',
      // Words/phrases the AI reads aloud (Web Speech API, no audio file) —
      // set by the teacher in the unit editor, shown as a "vocabulary"
      // widget on the course page.
      vocabulary: safeParseJson_(unit.vocabulary),
      units: lessonGroups,
      videos: videos.length,
      exams: exams.length,
      duration: 0,
      students: 0,
      popular: false,
      rating: 0
    });
  }

  // No courseId = admin list all units
  if (req.user.role !== 'admin') {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }
  const units = await db.getAll('Units');
  units.sort((a, b) => (parseFloat(a.order) || 0) - (parseFloat(b.order) || 0));
  res.json({ ok: true, data: units });
}));

// Public list (no auth needed)
router.get('/public', asyncHandler(async (req, res) => {
  const units = await db.getAll('Units');
  res.json({ ok: true, data: units.filter((u) => u.status === 'published') });
}));

router.use(requireAuth, requireRole('admin'));

router.get('/:id', asyncHandler(async (req, res) => {
  const unit = await db.getById('Units', req.params.id);
  if (!unit) return res.status(404).json({ ok: false, error: 'Unit not found' });
  res.json({ ok: true, data: { ...unit, vocabulary: safeParseJson_(unit.vocabulary) } });
}));

router.post('/', asyncHandler(async (req, res) => {
  const { title, description, order, coverImageUrl } = req.body;
  if (!title) return res.status(400).json({ ok: false, error: 'title is required' });
  const unit = await db.insert('Units', {
    title, description: description || '', order: order || 0,
    coverImageUrl: coverImageUrl || '', status: 'draft'
  });
  res.status(201).json({ ok: true, data: unit });
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const patch = { ...req.body };
  if (patch.vocabulary !== undefined) patch.vocabulary = JSON.stringify(patch.vocabulary);
  const updated = await db.update('Units', req.params.id, patch);
  if (!updated) return res.status(404).json({ ok: false, error: 'Unit not found' });
  res.json({ ok: true, data: updated });
}));

router.post('/:id/publish', asyncHandler(async (req, res) => {
  const updated = await db.update('Units', req.params.id, { status: 'published' });
  res.json({ ok: true, data: updated });
}));

router.post('/:id/hide', asyncHandler(async (req, res) => {
  const updated = await db.update('Units', req.params.id, { status: 'hidden' });
  res.json({ ok: true, data: updated });
}));

router.post('/:id/duplicate', asyncHandler(async (req, res) => {
  const original = await db.getById('Units', req.params.id);
  if (!original) return res.status(404).json({ ok: false, error: 'Unit not found' });

  const copy = await db.insert('Units', {
    title: original.title + ' (Copy)', description: original.description,
    order: original.order, coverImageUrl: original.coverImageUrl, status: 'draft'
  });

  // Duplicate lessons/videos/books/exams (shallow: videos & books reference the SAME Drive file, no re-upload)
  const [lessons, videos, books, exams] = await Promise.all([
    db.find('Lessons', { unitId: original.id }),
    db.find('Videos', { unitId: original.id }),
    db.find('Books', { unitId: original.id }),
    db.find('Exams', { unitId: original.id })
  ]);

  await Promise.all(lessons.map((l) => db.insert('Lessons', { ...stripId(l), unitId: copy.id })));
  await Promise.all(videos.map((v) => db.insert('Videos', { ...stripId(v), unitId: copy.id })));
  await Promise.all(books.map((b) => db.insert('Books', { ...stripId(b), unitId: copy.id })));

  for (const exam of exams) {
    const newExam = await db.insert('Exams', { ...stripId(exam), unitId: copy.id });
    const questions = await db.find('Questions', { examId: exam.id });
    await Promise.all(questions.map((q) => db.insert('Questions', { ...stripId(q), examId: newExam.id })));
  }

  res.status(201).json({ ok: true, data: copy });
}));

router.post('/reorder', asyncHandler(async (req, res) => {
  const { orderedIds } = req.body; // array of unit ids in the new order
  if (!Array.isArray(orderedIds)) {
    return res.status(400).json({ ok: false, error: 'orderedIds must be an array' });
  }
  await Promise.all(orderedIds.map((id, index) => db.update('Units', id, { order: index })));
  res.json({ ok: true, data: { reordered: orderedIds.length } });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  // Cascade delete lessons/videos/books/exams/questions belonging to this unit
  const [lessons, videos, books, exams] = await Promise.all([
    db.find('Lessons', { unitId: req.params.id }),
    db.find('Videos', { unitId: req.params.id }),
    db.find('Books', { unitId: req.params.id }),
    db.find('Exams', { unitId: req.params.id })
  ]);

  await Promise.all(lessons.map((l) => db.remove('Lessons', l.id)));
  await Promise.all(videos.map((v) => db.remove('Videos', v.id).then(() => v.driveFileId && gas.deleteFile(v.driveFileId))));
  await Promise.all(books.map((b) => db.remove('Books', b.id).then(() => b.driveFileId && gas.deleteFile(b.driveFileId))));

  for (const exam of exams) {
    const questions = await db.find('Questions', { examId: exam.id });
    await Promise.all(questions.map((q) => db.remove('Questions', q.id)));
    await db.remove('Exams', exam.id);
  }

  const result = await db.remove('Units', req.params.id);
  res.json({ ok: true, data: result });
}));

function stripId(obj) {
  const { id, ...rest } = obj;
  return rest;
}

module.exports = router;
