const db = require('../lib/db.js');
const fs = require('fs');
(async () => {
  await db.init('C:/Users/Administrator/AppData/Roaming/local-ebook-library');
  const b = db.getById(933);
  console.log(JSON.stringify({
    title: b.title, author: b.author, ext: b.ext,
    cover_state: b.cover_state, cover_path: b.cover_path,
    progress: b.progress, location: (b.location || '').slice(0, 80),
    status: b.status,
  }, null, 2));
  if (b.cover_path) console.log('cover exists:', fs.existsSync(b.cover_path), fs.existsSync(b.cover_path) ? fs.statSync(b.cover_path).size : 0);
})();
