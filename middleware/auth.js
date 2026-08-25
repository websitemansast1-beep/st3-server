const jwt = require('jsonwebtoken');
const config = require('../config/config');

function signAccessToken(user) {
  return jwt.sign(user, config.jwt.accessSecret, { expiresIn: config.jwt.accessExpires });
}
function signRefreshToken(user) {
  return jwt.sign(user, config.jwt.refreshSecret, { expiresIn: config.jwt.refreshExpires });
}
function verifyRefreshToken(token) {
  return jwt.verify(token, config.jwt.refreshSecret);
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ ok: false, error: 'Missing token' });
  try {
    req.user = jwt.verify(token, config.jwt.accessSecret);
    next();
  } catch (err) {
    return res.status(401).json({ ok: false, error: 'Invalid or expired token' });
  }
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== role) {
      return res.status(403).json({ ok: false, error: 'Forbidden' });
    }
    next();
  };
}

module.exports = {
  signAccessToken, signRefreshToken, verifyRefreshToken,
  requireAuth, requireRole
};
