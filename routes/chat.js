const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const gas = require('../services/gasClient');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// ================= Student side =================
// GET /api/chat/me  - the logged-in student's own thread with the teacher
router.get('/me', requireAuth, requireRole('student'), asyncHandler(async (req, res) => {
  const messages = await gas.find('Messages', { studentId: req.user.id });
  messages.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  // Mark admin messages as read by the student now that they're viewing the thread
  await Promise.all(
    messages
      .filter((m) => m.senderRole === 'admin' && String(m.isReadByStudent) !== 'true')
      .map((m) => gas.update('Messages', m.id, { isReadByStudent: true }))
  );

  res.json({ ok: true, data: messages });
}));

// POST /api/chat/me  { text }
router.post('/me', requireAuth, requireRole('student'), asyncHandler(async (req, res) => {
  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ ok: false, error: 'اكتب رسالة أولاً' });
  if (text.length > 4000) return res.status(400).json({ ok: false, error: 'الرسالة طويلة جداً' });

  const message = await gas.insert('Messages', {
    studentId: req.user.id,
    senderRole: 'student',
    text,
    isReadByAdmin: false,
    isReadByStudent: true
  });
  res.status(201).json({ ok: true, data: message });
}));

// GET /api/chat/me/unread-count  - lightweight poll target for a notification dot
router.get('/me/unread-count', requireAuth, requireRole('student'), asyncHandler(async (req, res) => {
  const messages = await gas.find('Messages', { studentId: req.user.id });
  const unread = messages.filter((m) => m.senderRole === 'admin' && String(m.isReadByStudent) !== 'true').length;
  res.json({ ok: true, data: { unread } });
}));

// ================= Admin side =================
router.use(requireAuth, requireRole('admin'));

// GET /api/chat/threads  - one row per student who has any messages, newest activity first
router.get('/threads', asyncHandler(async (req, res) => {
  const [messages, students] = await Promise.all([
    gas.getAll('Messages'),
    gas.getAll('Students')
  ]);

  const byStudent = {};
  messages.forEach((m) => {
    if (!byStudent[m.studentId]) byStudent[m.studentId] = [];
    byStudent[m.studentId].push(m);
  });

  const threads = Object.keys(byStudent).map((studentId) => {
    const msgs = byStudent[studentId].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    const last = msgs[msgs.length - 1];
    const student = students.find((s) => s.id === studentId);
    const unread = msgs.filter((m) => m.senderRole === 'student' && String(m.isReadByAdmin) !== 'true').length;
    return {
      studentId,
      studentName: student ? student.name : 'طالب محذوف',
      studentCode: student ? student.code : '',
      lastMessage: last ? last.text : '',
      lastMessageAt: last ? last.createdAt : '',
      unread
    };
  }).sort((a, b) => new Date(b.lastMessageAt) - new Date(a.lastMessageAt));

  res.json({ ok: true, data: threads });
}));

// GET /api/chat/:studentId  - full thread with one student, marks student messages as read
router.get('/:studentId', asyncHandler(async (req, res) => {
  const messages = await gas.find('Messages', { studentId: req.params.studentId });
  messages.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  await Promise.all(
    messages
      .filter((m) => m.senderRole === 'student' && String(m.isReadByAdmin) !== 'true')
      .map((m) => gas.update('Messages', m.id, { isReadByAdmin: true }))
  );

  res.json({ ok: true, data: messages });
}));

// POST /api/chat/:studentId  { text }
router.post('/:studentId', asyncHandler(async (req, res) => {
  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ ok: false, error: 'اكتب رسالة أولاً' });
  if (text.length > 4000) return res.status(400).json({ ok: false, error: 'الرسالة طويلة جداً' });

  const student = await gas.getById('Students', req.params.studentId);
  if (!student) return res.status(404).json({ ok: false, error: 'Student not found' });

  const message = await gas.insert('Messages', {
    studentId: req.params.studentId,
    senderRole: 'admin',
    text,
    isReadByAdmin: true,
    isReadByStudent: false
  });
  res.status(201).json({ ok: true, data: message });
}));

module.exports = router;
