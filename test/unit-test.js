// 临时单测：extract / db / scanner
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const { extractBook } = require('../lib/extract');
const db = require('../lib/db');
const { walk, makeTree } = require('../lib/scanner');

async function main() {
  const tmp = path.join(__dirname, 'tmp-books');
  fs.mkdirSync(path.join(tmp, '小说'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '技术'), { recursive: true });

  // 1) TXT
  fs.writeFileSync(path.join(tmp, '小说', '测试书籍.txt'), '第一章 开端\n\n这是一个测试文本，用于验证 TXT 解析与分页。\n第二章 发展\n内容内容内容。', 'utf8');

  // 2) 最小 EPUB（带元数据、无封面）
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml',
    `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  zip.file('OEBPS/content.opf',
    `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>测试EPUB之书</dc:title><dc:creator>张三</dc:creator><dc:description>这是一本用于自动化测试的 EPUB 书籍简介。</dc:description><identifier id="uid">test-123</identifier></metadata><manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`);
  zip.file('OEBPS/ch1.xhtml',
    `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>ch1</title></head><body><h1 id="c1h">第一章</h1><p>EPUB 第一章正文。</p></body></html>`);
  const epubBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  fs.writeFileSync(path.join(tmp, '技术', '测试EPUB.epub'), epubBuf);

  // 3) PDF 占位（非合法 PDF，验证失败兜底）
  fs.writeFileSync(path.join(tmp, '技术', 'broken.pdf'), 'not a real pdf', 'utf8');

  const covers = path.join(__dirname, 'tmp-covers');
  fs.mkdirSync(covers, { recursive: true });

  for (const rel of ['小说/测试书籍.txt', '技术/测试EPUB.epub', '技术/broken.pdf']) {
    const p = path.join(tmp, rel);
    const r = await extractBook(p, covers);
    console.log(rel, '=>', JSON.stringify(r));
  }

  // scanner
  const files = walk(tmp);
  console.log('walk count =', files.length, files.map((f) => f.ext));

  // db（临时目录）
  const userData = path.join(__dirname, 'tmp-userdata');
  fs.mkdirSync(userData, { recursive: true });
  await db.init(userData);
  for (const f of files) {
    const meta = await extractBook(f.path, covers);
    db.insertBook({ ...f, ...meta });
  }
  db.persist();

  const tree = makeTree(db.distinctDirs(), tmp, (abs) => db.folderCount(abs, tmp));
  console.log('tree root count =', tree.count, 'children =', tree.childList.map((c) => `${c.name}:${c.count}`));
  const all = db.listBooks({ dir: tmp, dirRoot: tmp, perPage: 10 });
  console.log('list total =', all.total, all.list.map((b) => b.title));
  const sub = db.listBooks({ dir: path.join(tmp, '小说'), dirRoot: tmp, perPage: 10 });
  console.log('sub dir total =', sub.total, sub.list.map((b) => b.title));
  const hit = db.listBooks({ dir: tmp, dirRoot: tmp, search: 'EPUB', perPage: 10 });
  console.log('search total =', hit.total, hit.list.map((b) => b.title));
  const nope = db.listBooks({ dir: tmp, dirRoot: tmp, search: '张三', perPage: 10 });
  console.log('search author total =', nope.total);

  console.log('TEST_DONE');
}
main().catch((e) => { console.error('TEST_FAIL', e); process.exit(1); });
