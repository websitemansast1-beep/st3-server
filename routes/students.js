const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const gas = require('../services/gasClient');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.get('/me', requireAuth, requireRole('student'), asyncHandler(async (req, res) => {
  const student = await gas.getById('Students', req.user.id);
  res.json({ ok: true, data: student });
}));

router.get('/me/units', requireAuth, requireRole('student'), asyncHandler(async (req, res) => {
  const student = await gas.getById('Students', req.user.id);
  const unitIds = (student.unitIds || '').split(',').filter(Boolean);
  const allUnits = await gas.getAll('Units');
  const unlocked = allUnits.filter((u) => unitIds.includes(u.id) && u.status === 'published');
  res.json({ ok: true, data: unlocked });
}));

// GET /api/students/my-courses  (student sees their unlocked units as "courses")
router.get('/my-courses', requireAuth, requireRole('student'), asyncHandler(async (req, res) => {
  const student = await gas.getById('Students', req.user.id);
  const unitIds = (student.unitIds || '').split(',').filter(Boolean);
  const allUnits = await gas.getAll('Units');
  const unlocked = allUnits.filter((u) => unitIds.includes(u.id) && u.status === 'published');

  // Build course list with progress info
  const courses = await Promise.all(unlocked.map(async (u) => {
    const videos = await gas.find('Videos', { unitId: u.id });
    const exams = await gas.find('Exams', { unitId: u.id });
    const progressRecords = await gas.find('VideoProgress', { studentId: req.user.id });
    const watched = progressRecords.filter((p) => videos.some((v) => v.id === p.videoId) && p.status === 'finished').length;
    const totalVids = videos.length;
    const progress = totalVids > 0 ? Math.round((watched / totalVids) * 100) : 0;

    return {
      id: u.id,
      title: u.title,
      description: u.description || '',
      icon: u.coverImageUrl || '📚',
      tag: 'مسجل',
      progress,
      videos: totalVids,
      exams: exams.length,
      students: 0 // not tracked per-unit in this schema
    };
  }));

  res.json({ courses });
}));

// GET /api/students/dashboard  (student overview)
router.get('/dashboard', requireAuth, requireRole('student'), asyncHandler(async (req, res) => {
  const student = await gas.getById('Students', req.user.id);
  const unitIds = (student.unitIds || '').split(',').filter(Boolean);

  // Counts
  const allAttempts = await gas.find('Attempts', { studentId: req.user.id });
  const completedAttempts = allAttempts.filter((a) => (a.status === 'graded' || a.status === 'submitted'));
  const avgScore = completedAttempts.length > 0
    ? Math.round(completedAttempts.reduce((s, a) => s + (parseFloat(a.percentage) || 0), 0) / completedAttempts.length)
    : 0;

  // Rank: compare against all students' average scores
  const allStudents = await gas.getAll('Students');
  const allAttemptsAll = await gas.getAll('Attempts');
  const studentAvgs = allStudents.map((s) => {
    const sa = allAttemptsAll.filter((a) => a.studentId === s.id && (a.status === 'graded' || a.status === 'submitted'));
    return { id: s.id, avg: sa.length > 0 ? sa.reduce((sum, a) => sum + (parseFloat(a.percentage) || 0), 0) / sa.length : 0 };
  }).sort((a, b) => b.avg - a.avg);
  const rank = studentAvgs.findIndex((s) => s.id === req.user.id) + 1;

  // Progress per course
  const allUnits = await gas.getAll('Units');
  const progress = await Promise.all(unitIds.map(async (uid) => {
    const u = allUnits.find((unit) => unit.id === uid);
    if (!u) return null;
    const videos = await gas.find('Videos', { unitId: uid });
    const exams = await gas.find('Exams', { unitId: uid });
    const progressRecords = await gas.find('VideoProgress', { studentId: req.user.id });
    const watched = progressRecords.filter((p) => videos.some((v) => v.id === p.videoId) && p.status === 'finished').length;
    const examsTaken = allAttempts.filter((a) => exams.some((e) => e.id === a.examId) && (a.status === 'graded' || a.status === 'submitted')).length;
    return {
      courseTitle: u.title,
      progress: videos.length > 0 ? Math.round((watched / videos.length) * 100) : 0,
      videosWatched: watched,
      totalVideos: videos.length,
      examsTaken
    };
  }));

  // Recent exams
  const recentExams = completedAttempts
    .sort((a, b) => new Date(b.finishTime) - new Date(a.finishTime))
    .slice(0, 5)
    .map((a) => {
      const exam = allAttemptsAll.find((e) => e.id === a.examId); // wrong, need to fetch exam
      return { title: 'امتحان', date: a.finishTime ? a.finishTime.split('T')[0] : '', score: Math.round(parseFloat(a.percentage) || 0) };
    });

  // Leaderboard
  const leaderboard = studentAvgs.slice(0, 10).map((s) => {
    const st = allStudents.find((x) => x.id === s.id);
    return { name: st ? st.name : '—', examsCount: allAttemptsAll.filter((a) => a.studentId === s.id && (a.status === 'graded' || a.status === 'submitted')).length, avgScore: Math.round(s.avg) };
  });

  res.json({
    courses: unitIds.length,
    exams: completedAttempts.length,
    avgScore,
    rank: rank || 1,
    progress: progress.filter(Boolean),
    recentExams,
    leaderboard
  });
}));

router.use(requireAuth, requireRole('admin'));

router.get('/', asyncHandler(async (req, res) => {
  const students = await gas.getAll('Students');
  const units = await gas.getAll('Units');
  const attempts = await gas.getAll('Attempts');
  const videos = await gas.getAll('Videos');
  const progressRecords = await gas.getAll('VideoProgress');

  const enriched = students.map((s) => {
    const unitIds = (s.unitIds || '').split(',').filter(Boolean);
    const course = units.find((u) => unitIds.includes(u.id));
    const sAttempts = attempts.filter((a) => a.studentId === s.id && (a.status === 'graded' || a.status === 'submitted'));
    const avgScore = sAttempts.length > 0 ? Math.round(sAttempts.reduce((sum, a) => sum + (parseFloat(a.percentage) || 0), 0) / sAttempts.length) : 0;
    const sVideos = videos.filter((v) => unitIds.includes(v.unitId));
    const watched = progressRecords.filter((p) => p.studentId === s.id && p.status === 'finished' && sVideos.some((v) => v.id === p.videoId)).length;
    return {
      id: s.id,
      name: s.name,
      code: s.code,
      courseTitle: course ? course.title : '—',
      progress: sVideos.length > 0 ? Math.round((watched / sVideos.length) * 100) : 0,
      examsTaken: sAttempts.length,
      avgScore,
      videosWatched: watched,
      totalVideos: sVideos.length
    };
  });

  res.json({ students: enriched });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const student = await gas.getById('Students', req.params.id);
  if (!student) return res.status(404).json({ ok: false, error: 'Student not found' });
  res.json({ ok: true, data: student });
}));

// GET /api/students/:id/activity  - everything a specific student has been doing,
// used by the "search a student, see what they're up to" admin screen
router.get('/:id/activity', asyncHandler(async (req, res) => {
  const student = await gas.getById('Students', req.params.id);
  if (!student) return res.status(404).json({ ok: false, error: 'Student not found' });

  const [videos, units, videoProgress, attempts, exams, comments, presentationProgress] = await Promise.all([
    gas.getAll('Videos'),
    gas.getAll('Units'),
    gas.find('VideoProgress', { studentId: req.params.id }),
    gas.find('Attempts', { studentId: req.params.id }),
    gas.getAll('Exams'),
    gas.getAll('Comments'),
    gas.find('BookProgress', { studentId: req.params.id })
  ]);

  const unitIds = (student.unitIds || '').split(',').filter(Boolean);
  const enrolledUnits = units.filter((u) => unitIds.includes(u.id)).map((u) => ({ id: u.id, title: u.title }));

  const videoActivity = videoProgress
    .map((p) => {
      const v = videos.find((vid) => vid.id === p.videoId);
      return {
        videoTitle: v ? v.title : 'فيديو محذوف',
        status: p.status,
        watchPercentage: Math.round(parseFloat(p.watchPercentage) || 0),
        lastUpdatedAt: p.lastUpdatedAt
      };
    })
    .sort((a, b) => new Date(b.lastUpdatedAt) - new Date(a.lastUpdatedAt));

  const examActivity = attempts
    .map((a) => {
      const ex = exams.find((e) => e.id === a.examId);
      return {
        attemptId: a.id,
        examTitle: ex ? ex.title : 'امتحان محذوف',
        percentage: Math.round(parseFloat(a.percentage) || 0),
        passed: String(a.passed) === 'true',
        status: a.status,
        finishTime: a.finishTime
      };
    })
    .sort((a, b) => new Date(b.finishTime) - new Date(a.finishTime));

  const myComments = comments
    .filter((c) => c.authorId === req.params.id)
    .map((c) => {
      const v = videos.find((vid) => vid.id === c.videoId);
      return { videoTitle: v ? v.title : 'فيديو محذوف', text: c.text, createdAt: c.createdAt };
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  res.json({
    ok: true,
    data: {
      student: { id: student.id, name: student.name, code: student.code, phone: student.phone, lastLoginAt: student.lastLoginAt },
      enrolledUnits,
      videosWatched: videoActivity.filter((v) => v.status === 'finished').length,
      videoActivity,
      booksOpened: presentationProgress.length,
      examActivity,
      comments: myComments
    }
  });
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const updated = await gas.update('Students', req.params.id, req.body);
  if (!updated) return res.status(404).json({ ok: false, error: 'Student not found' });
  res.json({ ok: true, data: updated });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const result = await gas.remove('Students', req.params.id);
  res.json({ ok: true, data: result });
}));

// Grant/revoke access to a unit without needing a fresh code
router.post('/:id/units/:unitId/grant', asyncHandler(async (req, res) => {
  const student = await gas.getById('Students', req.params.id);
  if (!student) return res.status(404).json({ ok: false, error: 'Student not found' });
  const ids = new Set((student.unitIds || '').split(',').filter(Boolean));
  ids.add(req.params.unitId);
  const updated = await gas.update('Students', student.id, { unitIds: [...ids].join(',') });
  res.json({ ok: true, data: updated });
}));

router.post('/:id/units/:unitId/revoke', asyncHandler(async (req, res) => {
  const student = await gas.getById('Students', req.params.id);
  if (!student) return res.status(404).json({ ok: false, error: 'Student not found' });
  const ids = new Set((student.unitIds || '').split(',').filter(Boolean));
  ids.delete(req.params.unitId);
  const updated = await gas.update('Students', student.id, { unitIds: [...ids].join(',') });
  res.json({ ok: true, data: updated });
}));

module.exports = router;
