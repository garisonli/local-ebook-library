const db = require('../lib/db.js');
const path = require('path');

const appData = process.env.APPDATA || '';

(async () => {
  await db.init(path.join(appData, 'local-ebook-library'));
  const b = db.getById(933);
  console.log('BEFORE:', b.progress, b.status, b.location);
  db.updateProgress(933, { progress: 0, location: ' ', status: '未读' });
  await db.persist();
  // location 可能残留旧 CFI，单独清一次
  db.updateProgress(933, { progress: 0, location: '', status: '未读' });
  await db.persist();
  const a = db.getById(933);
  console.log('AFTER :', a.progress, a.status, JSON.stringify(a.location));
  process.exit(0);
})();
