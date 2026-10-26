// 验证 EPUB 内嵌封面提取（meta[name=cover] + manifest properties）
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const { extractBook } = require('../lib/extract');

async function main() {
  const tmp = path.join(__dirname, 'tmp-books', '技术');
  fs.mkdirSync(tmp, { recursive: true });
  const covers = path.join(__dirname, 'tmp-covers2');
  fs.mkdirSync(covers, { recursive: true });

  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml',
    `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  zip.file('OEBPS/content.opf',
    `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>带封面的EPUB</dc:title><dc:creator>赵六</dc:creator><dc:description>内嵌封面测试书。</dc:description><identifier id="uid">t-777</identifier><meta name="cover" content="cover-img"/></metadata><manifest><item id="cover-img" href="cover.png" media-type="image/png" properties="cover-image"/><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`);
  zip.file('OEBPS/ch1.xhtml',
    `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>c</title></head><body><p>hi</p></body></html>`);
  // 用已有的 PNG 作为封面图
  zip.file('OEBPS/cover.png', fs.readFileSync(path.join(process.env.APPDATA, 'local-ebook-library', 'covers', '2cce001d4617e507546d8c2d.png')));

  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const file = path.join(tmp, '测试EPUB封面.epub');
  fs.writeFileSync(file, buf);

  const r = await extractBook(file, covers);
  console.log('extract =>', JSON.stringify(r));
  if (r.cover_state !== 1 || !r.cover_path || !fs.existsSync(r.cover_path)) {
    console.error('COVER FAIL');
    process.exit(1);
  }
  if (r.title !== '带封面的EPUB' || r.author !== '赵六') {
    console.error('META FAIL');
    process.exit(1);
  }
  console.log('EPUB_COVER_OK');
}
main().catch((e) => { console.error(e); process.exit(1); });
