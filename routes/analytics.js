const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const gas = require('../services/gasClient');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

// Overview cards: totals
router.get('/overview', asyncHandler(async (req, res) => {
  const [students, units, videos, books, exams, attempts, codes] = await Promise.all([
    gas.getAll('Students'), gas.getAll('Units'), gas.getAll('Videos'),
    gas.getAll('Books'), gas.getAll('Exams'), gas.getAll('Attempts'), gas.getAll('Codes')
  ]);
  res.json({
    ok: true,
    data: {
      totalStudents: students.length,
      totalUnits: units.length,
      publishedUnits: units.filter((u) => u.status === 'published').length,
      totalVideos: videos.length,
      totalBooks: books.length,
      totalExams: exams.length,
      totalAttempts: attempts.length,
      activeCodes: codes.filter((c) => c.status === 'active').length,
      unusedCodes: codes.filter((c) => c.status === 'unused').length
    }
  });
}));

// Signups / attempts over time (last 30 days), for a simple line chart
router.get('/timeseries', asyncHandler(async (req, res) => {
  const [students, attempts] = await Promise.all([gas.getAll('Students'), gas.getAll('Attempts')]);
  const days = buildLast30Days();
  const signups = countByDay(students.map((s) => s.createdAt), days);
  const attemptCounts = countByDay(attempts.map((a) => a.startTime), days);
  res.json({ ok: true, data: { days, signups, attempts: attemptCounts } });
}));

router.get('/top-students', asyncHandler(async (req, res) => {
  const [attempts, students] = await Promise.all([gas.getAll('Attempts'), gas.getAll('Students')]);
  const byStudent = aggregateAverage(attempts);
  const ranked = [...byStudent.entries()]
    .map(([studentId, avg]) => ({
      studentId, average: avg,
      name: (students.find((s) => s.id === studentId) || {}).name || 'Unknown'
    }))
    .sort((a, b) => b.average - a.average);

  res.json({ ok: true, data: { top: ranked.slice(0, 10), lowest: ranked.slice(-10).reverse() } });
}));

router.get('/video-stats', asyncHandler(async (req, res) => {
  const [videos, progress] = await Promise.all([gas.getAll('Videos'), gas.getAll('VideoProgress')]);
  const stats = videos.map((v) => {
    const rows = progress.filter((p) => p.videoId === v.id);
    const finished = rows.filter((r) => r.status === 'finished').length;
    return { videoId: v.id, title: v.title, views: rows.length, finished };
  });
  stats.sort((a, b) => b.views - a.views);
  res.json({ ok: true, data: { mostWatched: stats.slice(0, 10), leastWatched: [...stats].sort((a, b) => a.views - b.views).slice(0, 10) } });
}));

router.get('/book-stats', asyncHandler(async (req, res) => {
  const [books, progress] = await Promise.all([gas.getAll('Books'), gas.getAll('BookProgress')]);
  const stats = books.map((b) => {
    const rows = progress.filter((p) => p.bookId === b.id);
    return {
      bookId: b.id, title: b.title, opened: rows.length,
      finished: rows.filter((r) => r.status === 'finished').length
    };
  });
  res.json({ ok: true, data: stats.sort((a, b) => b.opened - a.opened) });
}));

router.get('/exam-stats', asyncHandler(async (req, res) => {
  const [exams, attempts] = await Promise.all([gas.getAll('Exams'), gas.getAll('Attempts')]);
  const stats = exams.map((e) => {
    const rows = attempts.filter((a) => a.examId === e.id && a.status !== 'in_progress');
    const avg = rows.length
      ? rows.reduce((sum, r) => sum + (parseFloat(r.percentage) || 0), 0) / rows.length
      : 0;
    return {
      examId: e.id, title: e.title, attempts: rows.length,
      averagePercentage: Math.round(avg * 100) / 100,
      passRate: rows.length ? Math.round((rows.filter((r) => String(r.passed) === 'true').length / rows.length) * 10000) / 100 : 0
    };
  });
  res.json({ ok: true, data: stats });
}));

router.get('/unit-performance', asyncHandler(async (req, res) => {
  const [units, exams, attempts] = await Promise.all([gas.getAll('Units'), gas.getAll('Exams'), gas.getAll('Attempts')]);
  const stats = units.map((u) => {
    const unitExamIds = exams.filter((e) => e.unitId === u.id).map((e) => e.id);
    const rows = attempts.filter((a) => unitExamIds.includes(a.examId));
    const avg = rows.length
      ? rows.reduce((sum, r) => sum + (parseFloat(r.percentage) || 0), 0) / rows.length
      : 0;
    return { unitId: u.id, title: u.title, attempts: rows.length, averagePercentage: Math.round(avg * 100) / 100 };
  });
  res.json({ ok: true, data: stats });
}));

// ---------- helpers ----------
function buildLast30Days() {
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}
function countByDay(dates, days) {
  const map = Object.fromEntries(days.map((d) => [d, 0]));
  dates.forEach((iso) => {
    if (!iso) return;
    const day = String(iso).slice(0, 10);
    if (map[day] !== undefined) map[day] += 1;
  });
  return days.map((d) => map[d]);
}
function aggregateAverage(attempts) {
  const graded = attempts.filter((a) => a.status === 'graded' || a.status === 'submitted');
  const sums = new Map();
  const counts = new Map();
  graded.forEach((a) => {
    sums.set(a.studentId, (sums.get(a.studentId) || 0) + (parseFloat(a.percentage) || 0));
    counts.set(a.studentId, (counts.get(a.studentId) || 0) + 1);
  });
  const result = new Map();
  sums.forEach((sum, studentId) => result.set(studentId, Math.round((sum / counts.get(studentId)) * 100) / 100));
  return result;
}

// GET /api/analytics/exam-results?examId=xxx
router.get('/exam-results', asyncHandler(async (req, res) => {
  const { examId } = req.query;

  let attempts = await gas.getAll('Attempts');
  attempts = attempts.filter((a) => a.status === 'graded' || a.status === 'submitted');
  if (examId) attempts = attempts.filter((a) => a.examId === examId);

  const students = await gas.getAll('Students');
  const exams = await gas.getAll('Exams');

  // Build results with student names
  const results = attempts.map((a) => {
    const st = students.find((s) => s.id === a.studentId);
    const ex = exams.find((e) => e.id === a.examId);
    const pct = parseFloat(a.percentage) || 0;
    const mins = Math.floor((parseInt(a.durationSeconds) || 0) / 60);
    return {
      name: st ? st.name : '—',
      score: Math.round(pct),
      time: mins + ' د',
      date: a.finishTime ? a.finishTime.split('T')[0] : ''
    };
  }).sort((a, b) => b.score - a.score);

  // Stats
  const scores = results.map((r) => r.score);
  const avgScore = scores.length > 0 ? Math.round(scores.reduce((s, v) => s + v, 0) / scores.length) : 0;
  const highestScore = scores.length > 0 ? Math.max(...scores) : 0;
  const lowestScore = scores.length > 0 ? Math.min(...scores) : 0;

  // Leaderboard (top 10)
  const leaderboard = results.slice(0, 10).map((r) => ({
    name: r.name,
    time: r.time,
    score: r.score
  }));

  res.json({
    avgScore,
    highestScore,
    lowestScore,
    attemptsCount: results.length,
    leaderboard,
    results
  });
}));

module.exports = router;
