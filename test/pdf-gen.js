// 生成一个最小但合法的 PDF（含 Info 元数据 + 可渲染文本页），用于端到端验证 pdf.js
const fs = require('fs');
const path = require('path');

function buildPdf() {
  const objects = [];
  objects.push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  objects.push('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  objects.push('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n');
  objects.push('4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n');
  const content = 'BT /F1 28 Tf 72 750 Td (PDF Test - Chapter 1) Tj ET\n' +
    'BT /F1 16 Tf 72 700 Td (This is a generated test page for snapshot and reader.) Tj ET\n' +
    'BT /F1 16 Tf 72 660 Td (Line three of the test document.) Tj ET\n';
  objects.push('5 0 obj\n<< /Length ' + content.length + ' >>\nstream\n' + content + 'endstream\nendobj\n');
  // 非 ASCII 元数据按规范用 UTF-16BE + BOM（pdf.js 可解）
  const u16 = (s) => {
    const buf = Buffer.from('\uFEFF' + s, 'utf16le').swap16();
    let esc = '';
    for (const b of buf) esc += '\\' + b.toString(8).padStart(3, '0');
    return '(' + esc + ')';
  };
  objects.push('6 0 obj\n<< /Title ' + u16('PDF 测试书') + ' /Author ' + u16('王五') + ' /Subject ' + u16('这是一本生成的测试 PDF 简介') + ' >>\nendobj\n');

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (const o of objects) {
    offsets.push(pdf.length);
    pdf += o;
  }
  const xrefStart = pdf.length;
  pdf += 'xref\n0 ' + (objects.length + 1) + '\n';
  pdf += '0000000000 65535 f \n';
  for (const off of offsets) {
    pdf += String(off).padStart(10, '0') + ' 00000 n \n';
  }
  pdf += 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R /Info 6 0 R >>\nstartxref\n' + xrefStart + '\n%%EOF\n';
  return Buffer.from(pdf, 'latin1');
}

const out = path.join(__dirname, 'tmp-books', '技术', '测试PDF.pdf');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, buildPdf());
console.log('generated:', out, fs.statSync(out).size, 'bytes');

const pdfMeta = require('../lib/pdf-meta');
pdfMeta.extract(out).then((r) => {
  console.log('pdfMeta =>', JSON.stringify(r));
  if (!r.title) { console.error('META FAIL'); process.exit(1); }
  console.log('PDF_GEN_OK');
}).catch((e) => { console.error('FAIL', e); process.exit(1); });
