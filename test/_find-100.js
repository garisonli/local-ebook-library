const db = require('../lib/db.js');
const path = require('path');

const appData = process.env.APPDATA || '';

(async () => {
  await db.init(path.join(appData, 'local-ebook-library'));
  const hits = [];
  const per = 500;
  for (let page = 1; page <= 12; page++) {
    const r = db.listBooks({ page, perPage: per });
    const list = r.list || r.books || r.items || [];
    if (!list.length) break;
    list.forEach((b) => {
      if ((b.progress || 0) >= 0.995) hits.push(b);
    });
  }
  console.log('rows at 100%:', hits.length);
  hits.slice(0, 40).forEach((b) => console.log(' ', b.id, b.progress, b.status, '|', b.title));
  process.exit(0);
})();
