// 批量修复 PDF 书名：应用 pickPdfTitle 取舍规则 + badTitle 兜底
// （内嵌元数据未变，无需重新读文件；只改 title，不动进度/封面/书签）
const path = require('path');
const db = require('../lib/db');
const { pickPdfTitle, badTitle, titleFromFilename } = require('../lib/extract');

async function main() {
  await db.init(path.join(process.env.APPDATA, 'local-ebook-library'));

  const pdfs = db.allBooks("ext = 'pdf'");
  let changed = 0;
  const samples = [];
  for (const b of pdfs) {
    let newTitle;
    if (badTitle(b.title)) newTitle = titleFromFilename(b.path);   // untitled / １１ 等直接回退文件名
    else newTitle = pickPdfTitle(b.title, b.path);                  // 短且不沾边的内嵌标题 → 信文件名
    if (newTitle !== b.title) {
      db.updateExtract(b.id, { ...b, title: newTitle });
      changed++;
      if (samples.length < 30) samples.push({ id: b.id, from: b.title, to: newTitle, file: b.filename });
    }
  }
  // 非 PDF 也清理明显的占位书名
  const others = db.allBooks("ext != 'pdf'");
  for (const b of others) {
    if (badTitle(b.title)) {
      const newTitle = titleFromFilename(b.path);
      if (newTitle !== b.title) {
        db.updateExtract(b.id, { ...b, title: newTitle });
        changed++;
        if (samples.length < 40) samples.push({ id: b.id, from: b.title, to: newTitle, file: b.filename });
      }
    }
  }
  db.persist();
  console.log('pdf total =', pdfs.length, ' changed =', changed);
  console.log(JSON.stringify(samples, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); });
