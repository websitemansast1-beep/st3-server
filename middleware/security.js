const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const config = require('../config/config');

const helmetMiddleware = helmet({
  contentSecurityPolicy: false // frontend is same-origin static files; disabled to keep embeds (Drive preview iframes) working
});

// Auth here is a Bearer token in localStorage, never a cookie — so
// `credentials: true` (which exists for cookie-based auth) isn't needed
// and was only adding unused surface area. Dropping it also means the
// `cors` package won't reflect an arbitrary Origin back when
// CLIENT_ORIGIN is left at its default; see config.js for the startup
// warning if that default is still in place in production.
const corsMiddleware = cors({
  origin: config.clientOrigin === '*' ? true : config.clientOrigin.split(',')
});

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many requests, please slow down.' }
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many login attempts, try again later.' }
});

module.exports = { helmetMiddleware, corsMiddleware, generalLimiter, authLimiter };
