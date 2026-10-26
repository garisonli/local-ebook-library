// PDF 元数据读取（pdfjs-dist legacy build，Node 环境仅取元数据，不渲染）
const fs = require('fs');
const path = require('path');
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');

function clean(s) {
  if (!s) return '';
  return String(s).replace(/\s+/g, ' ').trim();
}

async function extract(filePath) {
  let doc = null;
  try {
    const data = new Uint8Array(fs.readFileSync(filePath));
    doc = await pdfjs.getDocument({
      data,
      isEvalSupported: false,
      useSystemFonts: false,
      disableFontFace: true,
      disableRange: true,
      disableStream: true,
      verbosity: 0,
    }).promise;

    const md = await doc.getMetadata();
    const info = (md && md.info) || {};
    let title = clean(info.Title);
    let author = clean(info.Author);
    let description = clean(info.Subject);

    // dc:title / dc:description（部分 PDF 用 XMP）
    if (!title && md && md.metadata && typeof md.metadata.getAll === 'function') {
      const xmp = md.metadata.getAll();
      if (!title && xmp['dc:title']) title = clean(xmp['dc:title']);
      if (!author && xmp['dc:creator']) author = clean(xmp['dc:creator']);
      if (!description && xmp['dc:description']) description = clean(xmp['dc:description']);
    }
    return { title, author, description };
  } catch (e) {
    return { title: '', author: '', description: '' };
  } finally {
    if (doc) {
      try { await doc.destroy(); } catch (e) { /* ignore */ }
    }
  }
}

module.exports = { extract };
