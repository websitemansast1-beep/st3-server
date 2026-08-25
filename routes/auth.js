const express = require('express');
const bcrypt = require('bcryptjs');
const asyncHandler = require('../utils/asyncHandler');
const gas = require('../services/gasClient');
const { signAccessToken, signRefreshToken, verifyRefreshToken, requireAuth, requireRole } = require('../middleware/auth');
const config = require('../config/config');
const { withLock } = require('../utils/idempotency');

const router = express.Router();

/**
 * Bootstraps the very first admin account if the Admins sheet is empty.
 * This lets the teacher log in the first time without anyone manually
 * editing the spreadsheet.
 *
 * Every admin login used to call gas.countAdmins() unconditionally before
 * even looking the admin up — an extra Sheets round trip (real bottleneck:
 * ~1-3s per Apps Script call, see gasClient.js) on top of the actual
 * login, on EVERY request, forever. It only ever matters once, the very
 * first time an admin logs in after the sheet is created — so remember
 * that we've already confirmed an admin exists and skip the check for
 * the rest of this process's life.
 */
let bootstrapChecked = false;
async function ensureBootstrapAdmin() {
  if (bootstrapChecked) return;
  const adminCount = await gas.countAdmins();
  if (adminCount === 0) {
    const passwordHash = await bcrypt.hash(config.bootstrapAdmin.password, 10);
    await gas.insertAdmin({
      username: config.bootstrapAdmin.username,
      passwordHash,
      name: config.bootstrapAdmin.name,
      role: 'admin'
    });
  }
  bootstrapChecked = true;
}

/**
 * A Codes row with no unitId is a general-access code: it should unlock
 * every currently published course, not just one. This is re-resolved on
 * every login (not just the first) so a general code also unlocks any
 * course published after the student first signed in.
 */
async function resolveGrantedUnitIds(codeRecord) {
  if (codeRecord.unitId) return [codeRecord.unitId];
  const units = await gas.find('Units', { status: 'published' });
  return units.map((u) => u.id);
}

/**
 * A student "logs in" with just a code — the code IS the credential, name
 * and phone are just profile info. That means whoever knows the code
 * string can log in. That's fine for the FIRST login (claiming an unused
 * code is the whole point) — but for every login after that, it used to
 * hand back the EXISTING student's account (their real name, their exam
 * history, their access token) to whoever typed the code in, without
 * checking whether the phone number matched who actually owns that
 * account. Found during a security review: anyone who overhears/guesses
 * an already-claimed code could log in AS that student.
 * Now: once a code is claimed, a login attempt on it must match the
 * phone number on file (loosely normalized — spaces/dashes/leading
 * zero/country code don't matter) or it's rejected.
 */
function normalizePhone_(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.slice(-9); // last 9 digits — drops any leading 0 or +20/0020 country-code variation
}

async function loginOrCreateStudent(codeRecord, name, phone, guardianPhone) {
  // These two reads don't depend on each other — running them together
  // instead of one after another cuts a real ~1-3s Sheets round trip off
  // every login that uses a general-access code (no unitId).
  const [grantedUnitIds, existingMatches] = await Promise.all([
    resolveGrantedUnitIds(codeRecord),
    gas.find('Students', { code: codeRecord.code })
  ]);
  const existingByCode = existingMatches[0];

  let student;
  if (existingByCode) {
    if (normalizePhone_(existingByCode.phone) !== normalizePhone_(phone)) {
      throw Object.assign(
        new Error('الكود ده متسجل برقم تليفون مختلف. لو ده كودك، ادخل بنفس رقم التليفون اللي سجلت بيه أول مرة، أو كلم المعلم.'),
        { status: 401 }
      );
    }
    const currentUnitIds = new Set((existingByCode.unitIds || '').split(',').filter(Boolean));
    grantedUnitIds.forEach((id) => currentUnitIds.add(id));
    student = await gas.update('Students', existingByCode.id, {
      unitIds: [...currentUnitIds].join(','),
      lastLoginAt: new Date().toISOString()
    });
  } else {
    student = await gas.insert('Students', {
      name,
      phone: phone || '',
      guardianPhone: guardianPhone || '',
      code: codeRecord.code,
      unitIds: grantedUnitIds.join(','),
      lastLoginAt: new Date().toISOString()
    });
  }

  if (codeRecord.status !== 'active') {
    await gas.update('Codes', codeRecord.id, {
      status: 'active',
      studentId: student.id,
      studentName: student.name,
      activationDate: new Date().toISOString()
    });
  }

  return student;
}

// POST /api/auth/admin/login
router.post('/admin/login', asyncHandler(async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ ok: false, error: 'username and password are required' });
  }

  await ensureBootstrapAdmin();

  const admin = await gas.getAdminByUsername(username);
  if (!admin) return res.status(401).json({ ok: false, error: 'Invalid credentials' });

  const valid = await bcrypt.compare(password, admin.passwordHash);
  if (!valid) return res.status(401).json({ ok: false, error: 'Invalid credentials' });

  const userPayload = { id: admin.id, username: admin.username, name: admin.name, role: 'admin' };
  const accessToken = signAccessToken(userPayload);
  const refreshToken = signRefreshToken(userPayload);

  res.json({ ok: true, data: { accessToken, refreshToken, user: userPayload } });
}));

// POST /api/auth/change-password  { currentPassword, newPassword }  (admin only)
router.post('/change-password', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ ok: false, error: 'currentPassword and newPassword are required' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ ok: false, error: 'كلمة المرور الجديدة لازم تكون 8 حروف على الأقل' });
  }

  const admin = await gas.getAdminByUsername(req.user.username);
  if (!admin) return res.status(404).json({ ok: false, error: 'Admin not found' });

  const valid = await bcrypt.compare(currentPassword, admin.passwordHash);
  if (!valid) return res.status(401).json({ ok: false, error: 'كلمة المرور الحالية غلط' });

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await gas.updateAdminPassword(admin.id, passwordHash);

  res.json({ ok: true, data: { changed: true } });
}));

// POST /api/auth/student/login  { code, name, phone, guardianPhone }
router.post('/student/login', asyncHandler(async (req, res) => {
  const { code, name, phone, guardianPhone } = req.body;
  if (!code || !name || !phone || !guardianPhone) {
    return res.status(400).json({ ok: false, error: 'code, name, phone and guardianPhone are required' });
  }

  const normalizedCode = code.trim().toUpperCase();
  // Collapses concurrent duplicate logins for the same code (double-click,
  // a retried request) into ONE read-modify-write instead of two requests
  // racing to create/update the same student row.
  const student = await withLock(`login:${normalizedCode}`, async () => {
    const codeRecord = (await gas.find('Codes', { code: normalizedCode }))[0];
    if (!codeRecord) throw Object.assign(new Error('Invalid code'), { status: 401 });
    return loginOrCreateStudent(codeRecord, name, phone, guardianPhone);
  });

  const userPayload = { id: student.id, name: student.name, code: student.code, role: 'student' };
  const accessToken = signAccessToken(userPayload);
  const refreshToken = signRefreshToken(userPayload);

  res.json({ ok: true, data: { accessToken, refreshToken, user: userPayload } });
}));

// POST /api/auth/refresh { refreshToken }
router.post('/refresh', asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ ok: false, error: 'refreshToken required' });
  try {
    const payload = verifyRefreshToken(refreshToken);
    const { iat, exp, ...userPayload } = payload;
    const accessToken = signAccessToken(userPayload);
    res.json({ ok: true, data: { accessToken } });
  } catch (err) {
    res.status(401).json({ ok: false, error: 'Invalid refresh token' });
  }
}));

// ========== FRONTEND COMPATIBILITY ALIASES ==========
// The Vercel frontends call these exact paths.

// POST /api/auth/login  (admin login alias)
router.post('/login', asyncHandler(async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ ok: false, error: 'username and password are required' });
  }

  await ensureBootstrapAdmin();

  const admin = await gas.getAdminByUsername(username);
  if (!admin) return res.status(401).json({ ok: false, error: 'Invalid credentials' });

  const valid = await bcrypt.compare(password, admin.passwordHash);
  if (!valid) return res.status(401).json({ ok: false, error: 'Invalid credentials' });

  const userPayload = { id: admin.id, username: admin.username, name: admin.name, role: 'admin' };
  const token = signAccessToken(userPayload);
  const refreshToken = signRefreshToken(userPayload);

  // Return format expected by the Vercel admin frontend
  res.json({ token, user: userPayload, refreshToken });
}));

// POST /api/auth/student-login  (student login alias)
router.post('/student-login', asyncHandler(async (req, res) => {
  const { code, name, phone, guardianPhone } = req.body;
  if (!code || !name || !phone || !guardianPhone) {
    return res.status(400).json({ ok: false, error: 'code, name, phone and guardianPhone are required' });
  }

  const normalizedCode = code.trim().toUpperCase();
  const student = await withLock(`login:${normalizedCode}`, async () => {
    const codeRecord = (await gas.find('Codes', { code: normalizedCode }))[0];
    if (!codeRecord) throw Object.assign(new Error('Invalid code'), { status: 401 });
    return loginOrCreateStudent(codeRecord, name, phone, guardianPhone);
  });

  const userPayload = { id: student.id, name: student.name, code: student.code, role: 'student' };
  const token = signAccessToken(userPayload);
  const refreshToken = signRefreshToken(userPayload);

  // Return format expected by the Vercel student frontend
  res.json({ token, user: userPayload, refreshToken });
}));

module.exports = router;
