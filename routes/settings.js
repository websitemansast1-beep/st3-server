const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const gas = require('../services/gasClient');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// Public: minimal settings the student site needs (branding, dark mode default)
router.get('/public', asyncHandler(async (req, res) => {
  const all = await gas.getSettings();
  const map = Object.fromEntries(all.map((s) => [s.key, s.value]));
  res.json({
    ok: true,
    data: { platformName: map.platformName || 'Educational Platform', defaultDarkMode: map.defaultDarkMode === 'true' }
  });
}));

router.use(requireAuth, requireRole('admin'));

router.get('/', asyncHandler(async (req, res) => {
  const all = await gas.getSettings();
  res.json({ ok: true, data: all });
}));

router.post('/', asyncHandler(async (req, res) => {
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ ok: false, error: 'key is required' });
  const result = await gas.updateSetting(key, value);
  res.json({ ok: true, data: result });
}));

module.exports = router;
