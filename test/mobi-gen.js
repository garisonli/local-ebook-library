// 生成一个合法的最小 MOBI 文件（无压缩正文 + EXTH 元数据 + PNG 封面）
const fs = require('fs');
const path = require('path');

function u32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; }
function exth(type, data) { return Buffer.concat([u32(type), u32(8 + data.length), data]); }

function build() {
  const title = '测试MOBI之书';
  const author = '李四';
  const desc = '这是一本合成的 MOBI 测试书，用于验证元数据解析与内嵌阅读。';
  const para1 = '从前有座山，山里有个故事。'.repeat(80);
  const para2 = '第二段内容：分页与目录测试。'.repeat(80);
  const html = `<html><head><title>t</title></head><body><h1 id="m1">第一章</h1><p>${para1}</p><h2 id="m2">第二节</h2><p>${para2}</p></body></html>`;
  const textBuf = Buffer.from(html, 'utf8');

  const coverPng = path.join(process.env.APPDATA, 'local-ebook-library', 'covers', '2cce001d4617e507546d8c2d.png');
  const imgBuf = fs.readFileSync(coverPng);

  const headerLen = 232; // MOBI 头长度（自魔数起）
  const exthStart = 16 + headerLen; // 248
  const rec0 = Buffer.alloc(512);

  // PalmDoc 头（16 字节）
  rec0.writeUInt16BE(1, 0);              // compression = 1（不压缩）
  rec0.writeUInt32BE(textBuf.length, 4); // 正文长度
  rec0.writeUInt16BE(4096, 6);           // 记录块大小
  rec0.writeUInt16BE(1, 8);              // 正文记录数
  rec0.writeUInt16BE(0, 14);             // 加密 = 0

  // MOBI 头（自 16 起）
  rec0.write('MOBI', 16, 'latin1');
  rec0.writeUInt32BE(headerLen, 20);
  rec0.writeUInt32BE(2, 24);     // mobi type
  rec0.writeUInt32BE(65001, 28); // UTF-8
  rec0.writeUInt32BE(1, 32);     // unique id
  rec0.writeUInt32BE(3, 36);     // file version

  // EXTH（自 248 起）
  const exthBody = Buffer.concat([
    exth(100, Buffer.from(author, 'utf8')),
    exth(103, Buffer.from(desc, 'utf8')),
    exth(503, Buffer.from(title, 'utf8')),
    exth(201, u32(0)), // 封面 = 图片列表第 0 张
  ]);
  rec0.write('EXTH', exthStart, 'latin1');
  rec0.writeUInt32BE(12 + exthBody.length, exthStart + 4);
  rec0.writeUInt32BE(4, exthStart + 8);
  exthBody.copy(rec0, exthStart + 12);

  // 全名
  const nameBuf = Buffer.from(title, 'utf8');
  const nameOff = 440;
  nameBuf.copy(rec0, nameOff);
  rec0.writeUInt32BE(nameOff, 80);
  rec0.writeUInt32BE(nameBuf.length, 84);

  const records = [rec0, textBuf, imgBuf];
  const n = records.length;
  const headerSize = 78 + n * 8;
  const offsets = [];
  let off = headerSize;
  for (const r of records) { offsets.push(off); off += r.length; }

  const head = Buffer.alloc(headerSize);
  head.write('TestMobi', 0, 'latin1');
  head.write('BOOK', 60, 'latin1');
  head.write('MOBI', 64, 'latin1');
  head.writeUInt16BE(n, 76);
  for (let i = 0; i < n; i++) {
    head.writeUInt32BE(offsets[i], 78 + i * 8);
    head.writeUInt16BE(i, 78 + i * 8 + 4);
    head.writeUInt16BE(0, 78 + i * 8 + 6);
  }
  return Buffer.concat([head, ...records]);
}

const out = path.join(__dirname, 'tmp-books', '技术', '测试MOBI.mobi');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, build());
console.log('generated:', out, fs.statSync(out).size, 'bytes');

// 自测解析
const mobi = require('../lib/mobi');
try {
  const meta = mobi.parseMeta(out);
  console.log('parseMeta =>', JSON.stringify({ title: meta.title, author: meta.author, desc: meta.description, cover: meta.cover && meta.cover.mime, coverLen: meta.cover && meta.cover.data.length }));
  const h = mobi.parseHtml(out);
  console.log('parseHtml => len', h.html.length, 'toc', JSON.stringify(h.toc));
} catch (e) {
  console.error('PARSE FAIL:', e && e.message, e && e.stack && e.stack.slice(0, 400));
  process.exit(1);
}
console.log('MOBI_GEN_OK');
