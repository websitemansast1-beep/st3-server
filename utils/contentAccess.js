const gas = require('../services/gasClient');

/**
 * Videos/Books/Presentations were only ever filtered by unit access in the
 * LIST endpoints (GET /unit/:unitId). The single-item endpoint
 * (GET /:id) checked auth (any logged-in student) but never checked
 * ENROLLMENT — so a student who knew or guessed another unit's video ID
 * could fetch its full record (including the Drive embed link) even
 * though they were never granted that unit. Found during a security
 * review; this is the fix, applied consistently to all three content
 * types below.
 *
 * Admins always pass (they're allowed to see everything). A student
 * passes only if the item's unitId is one they've been granted.
 */
async function assertStudentHasUnitAccess(req, item) {
  if (!item) return; // let the caller's own 404 handling take it from here
  if (req.user.role === 'admin') return;
  const student = await gas.getById('Students', req.user.id);
  const grantedUnitIds = new Set((student && student.unitIds || '').split(',').filter(Boolean));
  if (!grantedUnitIds.has(item.unitId)) {
    throw Object.assign(new Error('لسه معندكش صلاحية الوصول لده'), { status: 403 });
  }
}

module.exports = { assertStudentHasUnitAccess };
