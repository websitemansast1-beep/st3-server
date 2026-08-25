const express = require('express');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const asyncHandler = require('../utils/asyncHandler');
const gas = require('../services/gasClient');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

router.get('/', asyncHandler(async (req, res) => {
  const codes = await gas.getAll('Codes');
  const { unitId } = req.query;
  res.json({ ok: true, data: unitId ? codes.filter((c) => c.unitId === unitId) : codes });
}));

// POST /api/codes/generate  { unitId (optional — omit for a code that unlocks every course), count, prefix }
router.post('/generate', asyncHandler(async (req, res) => {
  const { unitId, count, prefix } = req.body;
  if (!count) return res.status(400).json({ ok: false, error: 'count is required' });
  const n = Math.min(parseInt(count, 10) || 0, 1000);
  if (n <= 0) return res.status(400).json({ ok: false, error: 'count must be a positive number (max 1000)' });

  // No unitId => a general-access code, not tied to one course.
  const codes = await gas.generateCodes(unitId || '', n, prefix);
  res.status(201).json({ ok: true, data: codes });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const result = await gas.remove('Codes', req.params.id);
  res.json({ ok: true, data: result });
}));

// GET /api/codes/export/excel?unitId=xxx
router.get('/export/excel', asyncHandler(async (req, res) => {
  const codes = await getFilteredCodes(req.query.unitId);
  const unit = req.query.unitId ? await gas.getById('Units', req.query.unitId) : null;

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Access Codes');
  sheet.columns = [
    { header: 'Code', key: 'code', width: 22 },
    { header: 'Unit', key: 'unit', width: 30 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Student', key: 'studentName', width: 24 },
    { header: 'Activation Date', key: 'activationDate', width: 22 }
  ];
  sheet.getRow(1).font = { bold: true };
  codes.forEach((c) => sheet.addRow({
    code: c.code, unit: unit ? unit.title : c.unitId, status: c.status,
    studentName: c.studentName, activationDate: c.activationDate
  }));

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="access-codes.xlsx"');
  await workbook.xlsx.write(res);
  res.end();
}));

// GET /api/codes/export/pdf?unitId=xxx
router.get('/export/pdf', asyncHandler(async (req, res) => {
  const codes = await getFilteredCodes(req.query.unitId);
  const unit = req.query.unitId ? await gas.getById('Units', req.query.unitId) : null;

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="access-codes.pdf"');

  const doc = new PDFDocument({ margin: 40 });
  doc.pipe(res);

  doc.fontSize(18).text(unit ? `Access Codes — ${unit.title}` : 'Access Codes', { align: 'center' });
  doc.moveDown();

  codes.forEach((c, i) => {
    doc.fontSize(12).text(`${i + 1}. ${c.code}   [${c.status}]`);
  });

  doc.end();
}));

// GET /api/codes/print?unitId=xxx  — simple printable HTML the browser can Ctrl+P
router.get('/print', asyncHandler(async (req, res) => {
  const codes = await getFilteredCodes(req.query.unitId);
  const unit = req.query.unitId ? await gas.getById('Units', req.query.unitId) : null;

  const cardsHtml = codes.map((c) => `
    <div class="card">
      <div class="unit">${escapeHtml(unit ? unit.title : '')}</div>
      <div class="code">${escapeHtml(c.code)}</div>
    </div>`).join('');

  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Print Codes</title>
  <style>
    body{font-family:Arial,sans-serif;margin:20px}
    .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
    .card{border:2px dashed #444;border-radius:10px;padding:16px;text-align:center}
    .unit{font-size:12px;color:#555;margin-bottom:6px}
    .code{font-size:20px;font-weight:bold;letter-spacing:1px}
    @media print{.no-print{display:none}}
  </style></head><body>
  <button class="no-print" onclick="window.print()">Print</button>
  <div class="grid">${cardsHtml}</div>
  </body></html>`);
}));

async function getFilteredCodes(unitId) {
  const codes = await gas.getAll('Codes');
  return unitId ? codes.filter((c) => c.unitId === unitId) : codes;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

module.exports = router;
