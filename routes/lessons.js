const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const gas = require('../services/gasClient');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// ---------- Student-facing (auth required, any role) ----------
// GET /api/lessons/unit/:unitId - all lessons in a course, sorted, with their
// videos/presentations/books nested underneath (grouped by lessonId).
router.get('/unit/:unitId', requireAuth, asyncHandler(async (req, res) => {
  const unitId = req.params.unitId;

  if (req.user.role === 'student') {
    const student = await gas.getById('Students', req.user.id);
    const unitIds = (student.unitIds || '').split(',').filter(Boolean);
    if (!unitIds.includes(unitId)) {
      return res.status(403).json({ ok: false, error: 'Access denied' });
    }
  }

  let [lessons, videos, presentations, books] = await Promise.all([
    gas.find('Lessons', { unitId }),
    gas.find('Videos', { unitId }),
    gas.find('Presentations', { unitId }),
    gas.find('Books', { unitId })
  ]);

  if (req.user.role !== 'admin') {
    lessons = lessons.filter((l) => l.status === 'published');
    videos = videos.filter((v) => v.status === 'published');
    presentations = presentations.filter((p) => p.status === 'published');
    books = books.filter((b) => b.status === 'published');
  }
  lessons.sort((a, b) => (parseFloat(a.order) || 0) - (parseFloat(b.order) || 0));

  const byLesson = (arr, lessonId) => arr
    .filter((item) => (item.lessonId || '') === lessonId)
    .sort((a, b) => (parseFloat(a.order) || 0) - (parseFloat(b.order) || 0));

  const data = lessons.map((l) => ({
    id: l.id,
    title: l.title,
    content: l.content || '',
    order: l.order,
    videos: byLesson(videos, l.id).map((v) => ({
      id: v.id, title: v.title, driveUrl: v.driveUrl,
      duration: v.durationSeconds ? Math.round(v.durationSeconds / 60) + ' د' : ''
    })),
    presentations: byLesson(presentations, l.id).map((p) => ({ id: p.id, title: p.title, driveUrl: p.driveUrl })),
    books: byLesson(books, l.id).map((b) => ({ id: b.id, title: b.title, driveUrl: b.driveUrl }))
  }));

  res.json({ ok: true, data });
}));

router.get('/:id', requireAuth, asyncHandler(async (req, res) => {
  const lesson = await gas.getById('Lessons', req.params.id);
  if (!lesson) return res.status(404).json({ ok: false, error: 'Lesson not found' });
  if (req.user.role === 'student') {
    const student = await gas.getById('Students', req.user.id);
    const unitIds = (student.unitIds || '').split(',').filter(Boolean);
    if (!unitIds.includes(lesson.unitId)) {
      return res.status(403).json({ ok: false, error: 'Access denied' });
    }
  }
  res.json({ ok: true, data: lesson });
}));

// ---------- Admin CRUD ----------
router.post('/', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const { unitId, title, content, order } = req.body;
  if (!unitId || !title) {
    return res.status(400).json({ ok: false, error: 'unitId and title are required' });
  }
  const lesson = await gas.insert('Lessons', {
    unitId, title, content: content || '', order: order || 0,
    status: 'published', createdAt: new Date().toISOString()
  });
  res.status(201).json({ ok: true, data: lesson });
}));

router.patch('/:id', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const updated = await gas.update('Lessons', req.params.id, req.body);
  if (!updated) return res.status(404).json({ ok: false, error: 'Lesson not found' });
  res.json({ ok: true, data: updated });
}));

router.delete('/:id', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  // Detach (not delete) any video/presentation/book that pointed at this lesson,
  // so they fall back to the course's ungrouped bucket instead of disappearing.
  const [videos, presentations, books] = await Promise.all([
    gas.find('Videos', { lessonId: req.params.id }),
    gas.find('Presentations', { lessonId: req.params.id }),
    gas.find('Books', { lessonId: req.params.id })
  ]);
  await Promise.all([
    ...videos.map((v) => gas.update('Videos', v.id, { lessonId: '' })),
    ...presentations.map((p) => gas.update('Presentations', p.id, { lessonId: '' })),
    ...books.map((b) => gas.update('Books', b.id, { lessonId: '' }))
  ]);
  const result = await gas.remove('Lessons', req.params.id);
  res.json({ ok: true, data: result });
}));

module.exports = router;
