// 恢复两本被文件名噪音覆盖的内嵌标题（重抽 + 新规则取舍），并抽查《武侯八阵兵法辑略》
const path = require('path');
const db = require('../lib/db');
const { extractBook, pickPdfTitle, badTitle, titleFromFilename } = require('../lib/extract');

const RESTORE = [3693, 5166]; // 老子新译 / 中华仙学养生全书：内嵌正确，文件名带作者出版社噪音

async function main() {
  await db.init(path.join(process.env.APPDATA, 'local-ebook-library'));
  const coversDir = path.join(process.env.APPDATA, 'local-ebook-library', 'covers');

  for (const id of RESTORE) {
    const b = db.getById(id);
    if (!b) continue;
    const m = await extractBook(b.path, coversDir);
    db.updateExtract(id, { ...b, title: m.title, author: m.author, description: m.description || b.description });
    console.log('[restore]', id, JSON.stringify({ title: m.title, author: m.author }));
  }

  // 抽查：目标书 + 原错误标题的兄弟书
  const check = db.allBooks("ext = 'pdf' AND path LIKE '%纵横权谋%'");
  const bad = [];
  for (const b of check) {
    // 同目录内嵌标题错误的重灾区检查
    const wrong = ['战 略', '太公金匮', '几 策', '潜夫论', 'untitled', '１１', '鬼谷子', '黄帝问玄女兵法'];
    if (wrong.includes(b.title)) bad.push({ id: b.id, title: b.title, file: b.filename });
  }
  const wuhou = check.find(b => b.filename.indexOf('武侯') >= 0);
  console.log('[武侯]', wuhou ? JSON.stringify({ id: wuhou.id, title: wuhou.title, author: wuhou.author }) : 'NOT FOUND');
  console.log('[still-wrong in dir]', JSON.stringify(bad));
  db.persist();
}
main().catch(e => { console.error(e); process.exit(1); });
