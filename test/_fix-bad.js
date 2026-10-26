const db = require('../lib/db.js');
const { extractBook } = require('../lib/extract.js');
const path = require('path');
const fs = require('fs');

const appData = process.env.APPDATA || '';
const userData = path.join(appData, 'local-ebook-library');
const coversDir = path.join(userData, 'covers');
fs.mkdirSync(coversDir, { recursive: true });

const BAD = [3691, 4452, 1704, 911, 2133, 3593, 3599, 215, 1635, 1953, 3696, 933];

(async () => {
  await db.init(userData);
  for (const id of BAD) {
    const b = db.getById(id);
    if (!b) { console.log('skip (no row)', id); continue; }
    try {
      const m = await extractBook(b.path, coversDir);
      // 只提升书名/作者，绝不让垃圾元数据覆盖已修好的值
      const title = (m.title && m.title !== b.title) ? m.title : b.title;
      const author = (m.author && !b.author) ? m.author : b.author;
      const coverOk = m.cover_state === 1 && m.cover_path && m.cover_path.indexOf(coversDir) === 0;
      db.updateExtract(id, {
        ...b,
        title, author,
        cover_path: coverOk ? m.cover_path : '',
        cover_state: coverOk ? 1 : -1,
      });
      const after = db.getById(id);
      console.log(id, '|', after.title.slice(0, 38).padEnd(38), '| cover', after.cover_state, after.cover_path ? path.basename(after.cover_path) : '(none)');
    } catch (e) {
      console.log(id, 'ERROR', String(e.message).slice(0, 100));
    }
  }
  await db.persist();
  console.log('DONE');
  process.exit(0);
})();
