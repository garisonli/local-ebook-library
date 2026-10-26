// 查询《武侯八阵兵法辑略》在库中的记录 + 直接抽取该文件元数据
const path = require('path');
const db = require('../lib/db');

async function main() {
  await db.init(path.join(process.env.APPDATA, 'local-ebook-library'));

  const fp = 'E:\\伴读学习\\电子书\\通识常识\\哲学经典\\纵横权谋\\《武侯八阵兵法辑略》.pdf';
  const b = db.getByPath(fp);
  console.log('[db getByPath]', b ? JSON.stringify({ id: b.id, title: b.title, author: b.author, filename: b.filename, ext: b.ext, cover_state: b.cover_state }) : null);

  const others = db.listBooks({ dir: 'E:\\伴读学习\\电子书\\通识常识\\哲学经典\\纵横权谋', dirRoot: 'E:\\伴读学习\\电子书', page: 1, perPage: 100 });
  console.log('[same dir]', JSON.stringify((others.list || others).map(r => ({ id: r.id, title: r.title, filename: r.filename })), null, 2));

  const coversDir = path.join(process.env.APPDATA, 'local-ebook-library', 'covers');
  const m = await require('../lib/extract').extractBook(fp, coversDir);
  console.log('[extract]', JSON.stringify({ title: m.title, author: m.author, ext: m.ext }, null, 2));
}
main().catch(e => console.log('[err]', e.message));
