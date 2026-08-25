const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const gas = require('../services/gasClient');
const { requireAuth, requireRole } = require('../middleware/auth');
const { assertStudentHasUnitAccess } = require('../utils/contentAccess');

const router = express.Router();

// ---------- Student-facing (auth required, any role) ----------
router.get('/unit/:unitId', requireAuth, asyncHandler(async (req, res) => {
  const items = await gas.find('Presentations', { unitId: req.params.unitId });
  items.sort((a, b) => (parseFloat(a.order) || 0) - (parseFloat(b.order) || 0));
  res.json({ ok: true, data: items.filter((p) => req.user.role === 'admin' || p.status === 'published') });
}));

router.get('/:id', requireAuth, asyncHandler(async (req, res) => {
  const item = await gas.getById('Presentations', req.params.id);
  if (!item) return res.status(404).json({ ok: false, error: 'Presentation not found' });
  await assertStudentHasUnitAccess(req, item);
  res.json({ ok: true, data: item });
}));

// ---------- Admin CRUD ----------
router.post('/', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const { unitId, lessonId, title, driveFileId, driveUrl, order, slideCount } = req.body;
  if (!unitId || !title || !driveUrl) {
    return res.status(400).json({ ok: false, error: 'unitId, title and driveUrl are required' });
  }
  const item = await gas.insert('Presentations', {
    unitId, lessonId: lessonId || '', title, driveFileId: driveFileId || '',
    driveUrl, order: order || 0, slideCount: slideCount || 0, status: 'published'
  });
  res.status(201).json({ ok: true, data: item });
}));

router.patch('/:id', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const updated = await gas.update('Presentations', req.params.id, req.body);
  if (!updated) return res.status(404).json({ ok: false, error: 'Presentation not found' });
  res.json({ ok: true, data: updated });
}));

router.delete('/:id', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const item = await gas.getById('Presentations', req.params.id);
  if (item && item.driveFileId) await gas.deleteFile(item.driveFileId);
  const result = await gas.remove('Presentations', req.params.id);
  res.json({ ok: true, data: result });
}));

module.exports = router;
