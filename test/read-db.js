// 查看库中书籍状态
const fs = require('fs');
const path = require('path');
const os = require('os');
const initSqlJs = require('sql.js');

async function main() {
  const dbPath = path.join(os.homedir(), 'AppData', 'Roaming', 'local-ebook-library', 'library-index.db');
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(dbPath));
  const st = db.prepare('SELECT id,title,author,ext,cover_state,cover_path,progress,status,description FROM books');
  const rows = [];
  while (st.step()) rows.push(st.getAsObject());
  console.log(JSON.stringify(rows, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
