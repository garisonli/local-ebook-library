const db = require('../lib/db.js');
const { extractBook } = require('../lib/extract.js');
const path = require('path');
const fs = require('fs');

const appData = process.env.APPDATA || '';
const userData = path.join(appData, 'local-ebook-library');
const coversDir = path.join(userData, 'covers');
fs.mkdirSync(coversDir, { recursive: true });

(async () => {
  await db.init(userData);
  const b = db.getById(933);
  const m = await extractBook(b.path, coversDir);
  db.updateExtract(933, { ...b, ...m });
  await db.persist();

  const after = db.getById(933);
  console.log('title :', after.title);
  console.log('author:', after.author || '(none)');
  console.log('cover :', after.cover_state, '|', after.cover_path);
  const ok = after.cover_path && after.cover_path.indexOf('local-ebook-library') > -1 && fs.existsSync(after.cover_path);
  console.log('cover in app dir:', ok, ok ? fs.statSync(after.cover_path).size + ' bytes' : '');
  process.exit(0);
})();
