const db = require('../lib/db.js');
const path = require('path');
const appData = process.env.APPDATA || '';

(async () => {
  await db.init(path.join(appData, 'local-ebook-library'));
  const r = db.listBooks({ page: 1, perPage: 5000 });
  const list = r.list || [];
  const hits = list.filter((b) => /[0-9a-f]{16,}/i.test(String(b.title || '')) || /^Unknown$/i.test(String(b.author || '')));
  console.log('total:', list.length, '| hash/unknown rows:', hits.length);
  hits.forEach((b) => console.log(' ', b.id, '|', b.ext, '|', String(b.title).slice(0, 40), '|', path.basename(b.path)));
  process.exit(0);
})();
