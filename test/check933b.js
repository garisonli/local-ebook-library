const db = require('../lib/db.js');
(async () => {
  await db.init('C:/Users/Administrator/AppData/Roaming/local-ebook-library');
  const b = db.getById(933);
  const fs = require('fs');
  const st = fs.statSync(b.path);
  console.log('db.title    =', b.title);
  console.log('db.mtime    =', b.mtime, new Date(b.mtime).toISOString());
  console.log('file.mtime  =', Math.floor(st.mtimeMs), new Date(st.mtimeMs).toISOString());
  console.log('db.file_size=', b.file_size, ' file.size=', st.size);
  console.log('mtime equal :', b.mtime === Math.floor(st.mtimeMs));
  console.log('progress=', b.progress, 'status=', b.status);
})();
