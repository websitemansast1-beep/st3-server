const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const gas = require('../services/gasClient');
const { requireAuth, requireRole } = require('../middleware/auth');
const { assertStudentHasUnitAccess } = require('../utils/contentAccess');

const router = express.Router();

router.get('/unit/:unitId', requireAuth, asyncHandler(async (req, res) => {
  const books = await gas.find('Books', { unitId: req.params.unitId });
  books.sort((a, b) => (parseFloat(a.order) || 0) - (parseFloat(b.order) || 0));
  res.json({ ok: true, data: books.filter((b) => req.user.role === 'admin' || b.status === 'published') });
}));

router.get('/:id', requireAuth, asyncHandler(async (req, res) => {
  const book = await gas.getById('Books', req.params.id);
  if (!book) return res.status(404).json({ ok: false, error: 'Book not found' });
  await assertStudentHasUnitAccess(req, book);
  res.json({ ok: true, data: book });
}));

router.post('/:id/track', requireAuth, requireRole('student'), asyncHandler(async (req, res) => {
  const { event } = req.body; // 'opened' | 'reading' | 'finished'
  const bookId = req.params.id;
  const studentId = req.user.id;
  const now = new Date().toISOString();

  const existing = (await gas.find('BookProgress', { studentId, bookId }))[0];
  if (existing) {
    const patch = { status: event, lastUpdatedAt: now };
    if (event === 'finished' && !existing.finishedAt) patch.finishedAt = now;
    const updated = await gas.update('BookProgress', existing.id, patch);
    return res.json({ ok: true, data: updated });
  }
  const created = await gas.insert('BookProgress', {
    studentId, bookId, status: event, openedAt: now, lastUpdatedAt: now,
    finishedAt: event === 'finished' ? now : ''
  });
  res.status(201).json({ ok: true, data: created });
}));

router.post('/', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const { unitId, lessonId, title, driveFileId, driveUrl, order, pageCount } = req.body;
  if (!unitId || !title || !driveUrl) {
    return res.status(400).json({ ok: false, error: 'unitId, title and driveUrl are required' });
  }
  const book = await gas.insert('Books', {
    unitId, lessonId: lessonId || '', title, driveFileId: driveFileId || '',
    driveUrl, order: order || 0, pageCount: pageCount || 0, status: 'published'
  });
  res.status(201).json({ ok: true, data: book });
}));

router.patch('/:id', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const updated = await gas.update('Books', req.params.id, req.body);
  if (!updated) return res.status(404).json({ ok: false, error: 'Book not found' });
  res.json({ ok: true, data: updated });
}));

router.delete('/:id', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const book = await gas.getById('Books', req.params.id);
  if (book && book.driveFileId) await gas.deleteFile(book.driveFileId);
  const result = await gas.remove('Books', req.params.id);
  res.json({ ok: true, data: result });
}));

module.exports = router;
