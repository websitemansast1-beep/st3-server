const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const gas = require('../services/gasClient');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', asyncHandler(async (req, res) => {
  const all = await gas.getAll('Notifications');
  let mine;
  if (req.user.role === 'admin') {
    mine = all.filter((n) => n.audience === 'admin');
  } else {
    mine = all.filter((n) => n.audience === 'student' && n.studentId === req.user.id);
  }
  mine.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ ok: true, data: mine });
}));

router.post('/:id/read', asyncHandler(async (req, res) => {
  // Was missing an ownership check — any authenticated user (student or
  // admin) could mark ANY notification read by ID, not just their own.
  const notif = await gas.getById('Notifications', req.params.id);
  if (!notif) return res.status(404).json({ ok: false, error: 'Notification not found' });
  const owns = req.user.role === 'admin' ? notif.audience === 'admin' : notif.audience === 'student' && notif.studentId === req.user.id;
  if (!owns) return res.status(403).json({ ok: false, error: 'Forbidden' });

  const updated = await gas.update('Notifications', req.params.id, { isRead: true });
  res.json({ ok: true, data: updated });
}));

router.post('/read-all', asyncHandler(async (req, res) => {
  const all = await gas.getAll('Notifications');
  const mine = all.filter((n) =>
    req.user.role === 'admin'
      ? n.audience === 'admin'
      : n.audience === 'student' && n.studentId === req.user.id
  );
  await Promise.all(mine.filter((n) => !n.isRead).map((n) => gas.update('Notifications', n.id, { isRead: true })));
  res.json({ ok: true, data: { updated: mine.length } });
}));

// Admin: broadcast a manual notification to a student (or all students of a unit)
router.post('/broadcast', asyncHandler(async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false, error: 'Forbidden' });
  const { studentId, title, message } = req.body;
  const created = await gas.insert('Notifications', {
    audience: 'student', studentId, title, message, type: 'manual', isRead: false
  });
  res.status(201).json({ ok: true, data: created });
}));

module.exports = router;
