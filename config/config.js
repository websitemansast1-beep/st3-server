require('dotenv').config();
const path = require('path');
const crypto = require('crypto');

// Validate critical env vars
const missing = [];
if (!process.env.GAS_ENDPOINT_URL) missing.push('GAS_ENDPOINT_URL');
if (!process.env.GAS_API_KEY) missing.push('GAS_API_KEY');
if (!process.env.JWT_ACCESS_SECRET) missing.push('JWT_ACCESS_SECRET');
if (!process.env.JWT_REFRESH_SECRET) missing.push('JWT_REFRESH_SECRET');

if (missing.length > 0) {
  console.error('');
  console.error('❌❌❌ MISSING ENVIRONMENT VARIABLES ❌❌❌');
  console.error('The following variables are required but not set:');
  missing.forEach(v => console.error('   →', v));
  console.error('');
  console.error('Please set them in Railway Dashboard → Variables');
  console.error('');
}

// SECURITY: a hardcoded 'admin123'-style default password is exactly the
// kind of thing that ends up unchanged in a real deployment forever. If
// BOOTSTRAP_ADMIN_PASSWORD isn't set, generate a strong random one-time
// password instead of falling back to anything guessable, and print it
// ONCE so the teacher can grab it from the server logs on first boot.
// (It's saved — hashed — into the Admins sheet the first time an admin
// login happens; from then on it's just this admin account's real
// password, same as if a human had typed it in.)
let bootstrapAdminPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD;
if (!bootstrapAdminPassword) {
  bootstrapAdminPassword = crypto.randomBytes(9).toString('base64url');
  console.warn('');
  console.warn('⚠️  BOOTSTRAP_ADMIN_PASSWORD not set — generated a one-time random password.');
  console.warn('⚠️  First admin login → username: ' + (process.env.BOOTSTRAP_ADMIN_USERNAME || 'admin') + '   password: ' + bootstrapAdminPassword);
  console.warn('⚠️  Change it via "تغيير كلمة السر" right after logging in, or set BOOTSTRAP_ADMIN_PASSWORD explicitly and redeploy.');
  console.warn('');
}

if (process.env.NODE_ENV === 'production' && (!process.env.CLIENT_ORIGIN || process.env.CLIENT_ORIGIN === '*')) {
  console.warn('');
  console.warn('⚠️  CLIENT_ORIGIN is not set in production — CORS is reflecting ANY origin.');
  console.warn('⚠️  Set CLIENT_ORIGIN to your actual frontend URL(s) (comma-separated) to lock this down.');
  console.warn('');
}

module.exports = {
  port: process.env.PORT || 4000,
  nodeEnv: process.env.NODE_ENV || 'development',
  clientOrigin: process.env.CLIENT_ORIGIN || '*',

  gas: {
    endpointUrl: process.env.GAS_ENDPOINT_URL,
    apiKey: process.env.GAS_API_KEY
  },

  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET,
    refreshSecret: process.env.JWT_REFRESH_SECRET,
    accessExpires: process.env.JWT_ACCESS_EXPIRES || '15m',
    refreshExpires: process.env.JWT_REFRESH_EXPIRES || '30d'
  },

  bootstrapAdmin: {
    username: process.env.BOOTSTRAP_ADMIN_USERNAME || 'admin',
    password: bootstrapAdminPassword,
    name: process.env.BOOTSTRAP_ADMIN_NAME || 'Admin'
  },

  // ---------- Submission queue ----------
  // See backend/services/submissionQueue.js for the full design notes.
  submissionQueue: {
    // How many queued submissions get flushed to Google Sheets in one
    // batchUpdate call. Bigger = fewer Sheets operations but a longer wait
    // for the LAST student in a batch to see COMPLETED.
    batchSize: parseInt(process.env.SUBMISSION_BATCH_SIZE, 10) || 25,
    // Even if the batch never fills up (low traffic), flush whatever is
    // queued after this many ms so nobody waits indefinitely.
    flushIntervalMs: parseInt(process.env.SUBMISSION_FLUSH_INTERVAL_MS, 10) || 3000,
    // Retries per batch on a failed Sheets write, with short exponential
    // backoff (NOT long artificial sleeps) between attempts.
    maxRetries: parseInt(process.env.SUBMISSION_MAX_RETRIES, 10) || 3,
    retryBaseDelayMs: parseInt(process.env.SUBMISSION_RETRY_BASE_DELAY_MS, 10) || 500,
    // Local write-ahead log so a plain process restart (container restart,
    // crash+respawn on the SAME disk) can recover submissions that were
    // queued but not yet flushed. Does NOT survive a fresh deploy on a
    // platform with an ephemeral filesystem, and does NOT help at all if
    // you scale to multiple backend instances (see QUEUE_REPORT.md).
    walEnabled: process.env.SUBMISSION_WAL_ENABLED !== 'false',
    walPath: process.env.SUBMISSION_WAL_PATH || path.join(__dirname, '..', '.data', 'submission-queue.wal.jsonl')
  }
};
