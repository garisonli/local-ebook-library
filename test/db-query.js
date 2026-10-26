const db = require('E:/agnes workspace/ebook-library/lib/db.js');
(async () => {
  await db.init('C:/Users/Administrator/AppData/Roaming/local-ebook-library');
  const r = db.searchBooks('模仿的技术', 5);
  console.log(JSON.stringify(r.map((b) => ({ id: b.id, title: b.title, ext: b.ext, cover_state: b.cover_state, cover_path: b.cover_path })), null, 2));
})();
