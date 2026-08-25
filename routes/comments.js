const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const gas = require('../services/gasClient');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

// GET /api/comments/video/:videoId  - all comments on a video, oldest first
router.get('/video/:videoId', asyncHandler(async (req, res) => {
  const comments = await gas.find('Comments', { videoId: req.params.videoId });
  comments.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  res.json({ ok: true, data: comments });
}));

// POST /api/comments/video/:videoId  { text }
router.post('/video/:videoId', asyncHandler(async (req, res) => {
  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ ok: false, error: 'نص التعليق مطلوب' });
  if (text.length > 2000) return res.status(400).json({ ok: false, error: 'التعليق طويل جداً' });

  const comment = await gas.insert('Comments', {
    videoId: req.params.videoId,
    authorId: req.user.id,
    authorName: req.user.name,
    authorRole: req.user.role,
    text
  });
  res.status(201).json({ ok: true, data: comment });
}));

// DELETE /api/comments/:id  - the author or an admin (moderation) can remove a comment
router.delete('/:id', asyncHandler(async (req, res) => {
  const comment = await gas.getById('Comments', req.params.id);
  if (!comment) return res.status(404).json({ ok: false, error: 'Comment not found' });
  if (req.user.role !== 'admin' && comment.authorId !== req.user.id) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }
  const result = await gas.remove('Comments', req.params.id);
  res.json({ ok: true, data: result });
}));

module.exports = router;
