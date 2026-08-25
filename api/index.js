// Vercel serverless entry point.
// Vercel looks for a default-exported request handler under /api.
// We just hand it the same Express app used everywhere else (Railway,
// Render, local dev) — Vercel wraps it automatically, no code changes
// needed inside server.js besides not calling app.listen() at import time.
module.exports = require('../server');
