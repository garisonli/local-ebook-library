const db = require('../lib/db.js');
const path = require('path');
const fs = require('fs');
const appData = process.env.APPDATA || '';

(async () => {
  await db.init(path.join(appData, 'local-ebook-library'));
  const b = db.getById(933);
  console.log('title :', b.title);
  console.log('author:', b.author);
  console.log('cover :', b.cover_state, '|', b.cover_path);
  if (b.cover_path && fs.existsSync(b.cover_path)) {
    const st = fs.statSync(b.cover_path);
    const head = fs.readFileSync(b.cover_path).slice(0, 12);
    console.log('bytes :', st.size, '| mtime', new Date(st.mtime).toISOString(), '| head', head.toString('hex'));
  } else {
    console.log('bytes : COVER FILE MISSING');
  }
  process.exit(0);
})();
