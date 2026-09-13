const express = require('express');
const path = require('path');
const morgan = require('morgan');
const compression = require('compression');
const config = require('./config/config');
const { helmetMiddleware, corsMiddleware, generalLimiter, authLimiter } = require('./middleware/security');

const authRoutes = require('./routes/auth');
const unitsRoutes = require('./routes/units');
const lessonsRoutes = require('./routes/lessons');
const uploadRoutes = require('./routes/upload');
const videosRoutes = require('./routes/videos');
const booksRoutes = require('./routes/books');
const examsRoutes = require('./routes/exams');
const questionsRoutes = require('./routes/questions');
const attemptsRoutes = require('./routes/attempts');
const codesRoutes = require('./routes/codes');
const studentsRoutes = require('./routes/students');
const notificationsRoutes = require('./routes/notifications');
const analyticsRoutes = require('./routes/analytics');
const settingsRoutes = require('./routes/settings');
const presentationsRoutes = require('./routes/presentations');
const commentsRoutes = require('./routes/comments');
const chatRoutes = require('./routes/chat');
const loadtestRoutes = require('./routes/loadtest');

const app = express();
app.set('trust proxy', 1); // Required for Railway + express-rate-limit

app.use(helmetMiddleware);
app.use(corsMiddleware);
app.use(compression());
app.use(morgan(config.nodeEnv === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(generalLimiter);

app.get('/api/health', (req, res) => res.json({ ok: true, status: 'healthy', time: new Date().toISOString() }));

app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/units', unitsRoutes);
app.use('/api/lessons', lessonsRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/videos', videosRoutes);
app.use('/api/books', booksRoutes);
app.use('/api/exams', examsRoutes);
app.use('/api/questions', questionsRoutes);
app.use('/api/attempts', attemptsRoutes);
app.use('/api/codes', codesRoutes);
app.use('/api/students', studentsRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/presentations', presentationsRoutes);
app.use('/api/comments', commentsRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/loadtest', loadtestRoutes);

// ---------- Serve the frontend (admin dashboard + student site) ----------
// This expects a sibling `frontend/` directory (../frontend relative to this
// file) containing `admin/` and `student/` sub-apps. That layout only exists
// when this backend is deployed as a subfolder of a monorepo that also
// contains `frontend/` at the same level. If this backend is deployed as
// its OWN repo (no sibling frontend folder — e.g. this is the entire
// contents of the `st2server` repo), `frontendRoot` will not exist.
//
// Guarded with fs.existsSync so a missing frontend folder degrades to
// "API-only mode" (404 on non-/api routes) instead of crashing every
// request with ENOENT, or being mistaken by Railway's build detection for
// this being a static site. If you deploy frontend separately (its own
// Railway/Vercel/Netlify static site), that is the normal, expected case —
// this block simply won't do anything.
const fs = require('fs');
const frontendRoot = path.join(__dirname, '..', 'frontend');
if (fs.existsSync(frontendRoot)) {
  app.use('/admin', express.static(path.join(frontendRoot, 'admin')));
  app.use('/', express.static(path.join(frontendRoot, 'student')));

  app.get('/admin*', (req, res) => res.sendFile(path.join(frontendRoot, 'admin', 'index.html')));
  app.get('*', (req, res) => res.sendFile(path.join(frontendRoot, 'student', 'index.html')));
} else {
  console.warn(`[server] No frontend/ folder found at ${frontendRoot} — running API-only (this is expected if the frontend is deployed separately).`);
  app.get('*', (req, res) => res.status(404).json({ ok: false, error: 'Not found (API-only deployment — no frontend bundled)' }));
}

// ---------- Error handler ----------
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ ok: false, error: err.message || 'Internal server error' });
});

// On Vercel (and any other serverless platform) the app is imported and
// wrapped by the platform's own handler — it must never call listen()
// itself, or the deployment crashes/hangs. Only start a real HTTP server
// when this file is executed directly (`node server.js`, Railway, Render,
// local `npm run dev`, etc).
if (require.main === module) {
  app.listen(config.port, () => {
    console.log(`MFX Platform backend listening on port ${config.port} (${config.nodeEnv})`);
  });
}

module.exports = app;
