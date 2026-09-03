const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const gas = require('../services/gasClient');
const { requireAuth, requireRole } = require('../middleware/auth');
const { assertStudentHasUnitAccess } = require('../utils/contentAccess');
const router = express.Router();

// ---------- Student-facing (auth required, any role) ----------
router.get('/unit/:unitId', requireAuth, asyncHandler(async (req, res) => {
  const items = await gas.find('Presentations', { unitId: req.params.unitId });
  items.sort((a, b) => (parseFloat(a.order) || 0) - (parseFloat(b.order) || 0));
  res.json({ ok: true, data: items.filter((p) => req.user.role === 'admin' || p.status === 'published') });
}));

router.get('/:id', requireAuth, asyncHandler(async (req, res) => {
  const item = await gas.getById('Presentations', req.params.id);
  if (!item) return res.status(404).json({ ok: false, error: 'Presentation not found' });
  await assertStudentHasUnitAccess(req, item);
  res.json({ ok: true, data: item });
}));

// Returns the presentation as a list of standalone slide images for the
// custom in-platform viewer (instead of embedding Google's own Slides
// player). Generating these costs real time + Drive storage + a
// quota-limited Slides API call per slide, so the result is cached on
// the Presentations record itself (slideImages field) — this only calls
// out to Apps Script if nothing was cached yet (e.g. the presentation
// was created before this feature existed, or POST / below couldn't
// generate them at creation time), or when an admin forces a refresh.
router.get('/:id/slides', requireAuth, asyncHandler(async (req, res) => {
  const item = await gas.getById('Presentations', req.params.id);
  if (!item) return res.status(404).json({ ok: false, error: 'Presentation not found' });
  await assertStudentHasUnitAccess(req, item);

  if (!item.slidesId) {
    return res.status(400).json({
      ok: false,
      error: 'This presentation has not been converted to Google Slides yet, so slide images cannot be generated.'
    });
  }

  const forceRefresh = req.query.refresh === 'true' && req.user.role === 'admin';

  if (item.slideImages && !forceRefresh) {
    try {
      return res.json({ ok: true, data: { slideImages: JSON.parse(item.slideImages), cached: true } });
    } catch (e) {
      // fall through and regenerate if the cached JSON is somehow corrupt
    }
  }

  const result = await gas.getSlideImages(item.slidesId);
  await gas.update('Presentations', item.id, { slideImages: JSON.stringify(result.slideImages) });
  res.json({ ok: true, data: { slideImages: result.slideImages, cached: false } });
}));

// ---------- Admin CRUD ----------
router.post('/', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const { unitId, lessonId, title, driveFileId, driveUrl, order, slideCount, slidesId } = req.body;
  if (!unitId || !title || !driveUrl) {
    return res.status(400).json({ ok: false, error: 'unitId, title and driveUrl are required' });
  }

  const record = {
    unitId, lessonId: lessonId || '', title, driveFileId: driveFileId || '',
    driveUrl, order: order || 0, slideCount: slideCount || 0, status: 'published',
    slidesId: slidesId || '', slideImages: ''
  };

  // If this presentation was already converted to Google Slides (slidesId
  // came from the upload step's automatic PowerPoint->Slides conversion,
  // or from a prior call to /convert-slides below), generate its slide
  // images NOW, at creation time — instead of leaving the first student
  // who opens the page to wait on it. Failure here is non-fatal: the
  // presentation still gets created, just without cached images yet;
  // GET /:id/slides above will generate + cache them on first view.
  if (slidesId) {
    try {
      const result = await gas.getSlideImages(slidesId);
      record.slideImages = JSON.stringify(result.slideImages);
    } catch (err) {
      // left empty on purpose — see comment above
    }
  }

  const item = await gas.insert('Presentations', record);
  res.status(201).json({ ok: true, data: item });
}));

// Converts an already-shared Drive file (referenced only by a pasted
// link, never uploaded through this platform) into a Google Slides copy
// so it can be embedded with real next/previous slide navigation instead
// of a static file preview — see driveConvertToSlides in DriveUpload.gs.
// Always responds 200 even on failure (ok:false) since "couldn't
// convert, fall back to a plain preview" is an expected, handled
// outcome here, not a server error — the admin's own account might not
// have access to the source file, or the Advanced Drive API might not
// be enabled on the Apps Script project.
router.post('/convert-slides', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const { fileId } = req.body;
  if (!fileId) return res.status(400).json({ ok: false, error: 'fileId is required' });
  try {
    const result = await gas.convertToSlides(fileId);
    res.json({ ok: true, data: result });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
}));

router.patch('/:id', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const updated = await gas.update('Presentations', req.params.id, req.body);
  if (!updated) return res.status(404).json({ ok: false, error: 'Presentation not found' });
  res.json({ ok: true, data: updated });
}));

router.delete('/:id', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const item = await gas.getById('Presentations', req.params.id);
  if (item && item.driveFileId) await gas.deleteFile(item.driveFileId);
  const result = await gas.remove('Presentations', req.params.id);
  res.json({ ok: true, data: result });
}));

module.exports = router;
