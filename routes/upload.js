const express = require('express');
const multer = require('multer');
const asyncHandler = require('../utils/asyncHandler');
const gas = require('../services/gasClient');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// Keep files in memory only long enough to base64-encode and forward to Apps Script.
// Nothing is ever written to disk on the backend - Drive is the only storage.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 } // 500MB ceiling; Apps Script itself caps around ~50MB per call in practice for video
});

router.use(requireAuth, requireRole('admin'));

// POST /api/upload  (multipart/form-data: file, subfolder)
router.post('/', upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded' });

  const result = await gas.uploadFile({
    filename: req.file.originalname,
    mimeType: req.file.mimetype,
    base64Data: req.file.buffer.toString('base64'),
    subfolder: req.body.subfolder || 'misc',
    restrictDownload: req.body.restrictDownload === 'true'
  });

  // Backend/teacher only ever sees the returned link - the Drive mechanics are invisible.
  res.status(201).json({ ok: true, data: result });
}));

// DELETE /api/upload/:driveFileId  - used when a video/book is replaced
router.delete('/:driveFileId', asyncHandler(async (req, res) => {
  const result = await gas.deleteFile(req.params.driveFileId);
  res.json({ ok: true, data: result });
}));

module.exports = router;
