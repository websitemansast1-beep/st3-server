const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const gas = require('../services/gasClient');
const { requireAuth, requireRole } = require('../middleware/auth');
const { assertStudentHasUnitAccess } = require('../utils/contentAccess');

const router = express.Router();

// ---------- Student-facing (auth required, any role) ----------
router.get('/unit/:unitId', requireAuth, asyncHandler(async (req, res) => {
  const videos = await gas.find('Videos', { unitId: req.params.unitId });
  videos.sort((a, b) => (parseFloat(a.order) || 0) - (parseFloat(b.order) || 0));
  res.json({ ok: true, data: videos.filter((v) => req.user.role === 'admin' || v.status === 'published') });
}));

router.get('/:id', requireAuth, asyncHandler(async (req, res) => {
  const video = await gas.getById('Videos', req.params.id);
  if (!video) return res.status(404).json({ ok: false, error: 'Video not found' });
  await assertStudentHasUnitAccess(req, video);
  res.json({ ok: true, data: video });
}));

// Student progress ping - called periodically by the player (time-on-page based,
// since Google Drive's embedded player does not expose real playback events)
router.post('/:id/progress', requireAuth, requireRole('student'), asyncHandler(async (req, res) => {
  const { watchSeconds, watchPercentage } = req.body;
  const videoId = req.params.id;
  const studentId = req.user.id;

  const existing = (await gas.find('VideoProgress', { studentId, videoId }))[0];
  const now = new Date().toISOString();
  const pct = Math.min(100, Math.max(0, parseFloat(watchPercentage) || 0));
  let status = 'watching';
  if (pct >= 95) status = 'finished';

  if (existing) {
    const patch = {
      watchSeconds: Math.max(parseFloat(existing.watchSeconds) || 0, parseFloat(watchSeconds) || 0),
      watchPercentage: Math.max(parseFloat(existing.watchPercentage) || 0, pct),
      status: existing.status === 'finished' ? 'finished' : status,
      lastUpdatedAt: now,
      finishedAt: status === 'finished' && !existing.finishedAt ? now : existing.finishedAt
    };
    const updated = await gas.update('VideoProgress', existing.id, patch);
    return res.json({ ok: true, data: updated });
  }

  const created = await gas.insert('VideoProgress', {
    studentId, videoId, status, watchPercentage: pct, watchSeconds: watchSeconds || 0,
    startedAt: now, lastUpdatedAt: now, finishedAt: status === 'finished' ? now : ''
  });
  res.status(201).json({ ok: true, data: created });
}));

router.get('/:id/my-progress', requireAuth, requireRole('student'), asyncHandler(async (req, res) => {
  const existing = (await gas.find('VideoProgress', { studentId: req.user.id, videoId: req.params.id }))[0];
  res.json({ ok: true, data: existing || null });
}));

// ---------- Admin CRUD ----------
router.post('/', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const { unitId, lessonId, title, driveFileId, driveUrl, order, durationSeconds } = req.body;
  if (!unitId || !title || !driveUrl) {
    return res.status(400).json({ ok: false, error: 'unitId, title and driveUrl are required' });
  }
  const video = await gas.insert('Videos', {
    unitId, lessonId: lessonId || '', title, driveFileId: driveFileId || '',
    driveUrl, order: order || 0, durationSeconds: durationSeconds || 0, status: 'published'
  });
  res.status(201).json({ ok: true, data: video });
}));

router.patch('/:id', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const updated = await gas.update('Videos', req.params.id, req.body);
  if (!updated) return res.status(404).json({ ok: false, error: 'Video not found' });
  res.json({ ok: true, data: updated });
}));

router.delete('/:id', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const video = await gas.getById('Videos', req.params.id);
  if (video && video.driveFileId) await gas.deleteFile(video.driveFileId);
  const result = await gas.remove('Videos', req.params.id);
  res.json({ ok: true, data: result });
}));

// Teacher dashboard: didn't-watch / watching / finished breakdown for a video
router.get('/:id/stats', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const [progressRows, students] = await Promise.all([
    gas.find('VideoProgress', { videoId: req.params.id }),
    gas.getAll('Students')
  ]);
  const watchedIds = new Set(progressRows.map((p) => p.studentId));
  const video = await gas.getById('Videos', req.params.id);
  const relevantStudents = students.filter((s) => (s.unitIds || '').includes(video.unitId));

  res.json({
    ok: true,
    data: {
      finished: progressRows.filter((p) => p.status === 'finished').length,
      watching: progressRows.filter((p) => p.status === 'watching').length,
      didntWatch: relevantStudents.filter((s) => !watchedIds.has(s.id)).length,
      totalStudents: relevantStudents.length
    }
  });
}));

module.exports = router;
