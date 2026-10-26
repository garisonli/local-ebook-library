// 全库扫描 MOBI/AZW3，找出仍失败的书
const path = require('path');
const os = require('os');
const db = require('../lib/db');
const mobi = require('../lib/mobi');

(async () => {
  // 与 main.js 一致：app.getPath('userData') = %APPDATA%\<app名>
  // 从 package.json 读 name，避免猜错目录
  const pkg = require('../package.json');
  const appName = pkg.name; // local-ebook-library
  const userData = process.env.APPDATA
    ? path.join(process.env.APPDATA, appName)
    : path.join(os.homedir(), 'AppData', 'Roaming', appName);
  await db.init(userData);
  const books = db.allBooks("ext IN ('mobi','azw3','azw','prc','azw1')");
  console.log('total mobi-like:', books.length);
  const fails = [];
  let ok = 0;
  for (const b of books) {
    try {
      const r = mobi.parseHtml(b.path, {});
      const fffd = (r.html.match(/\uFFFD/g) || []).length;
      const tags = (r.html.match(/<[a-zA-Z!?/]/g) || []).length;
      if (r.html.length < 200 || tags < 5) {
        fails.push({ id: b.id, title: b.title, reason: `内容过少 len=${r.html.length} tags=${tags}` });
      } else {
        ok++;
        if (fffd > r.html.length * 0.01) {
          fails.push({ id: b.id, title: b.title, reason: `乱码率高 fffd=${fffd} len=${r.html.length}` });
        }
      }
    } catch (e) {
      fails.push({ id: b.id, title: b.title, reason: 'EXC: ' + e.message });
    }
  }
  console.log('OK:', ok, ' FAIL:', fails.length);
  for (const f of fails) console.log(`FAIL id=${f.id} [${f.title}] ${f.reason}`);
})().catch(e => { console.error(e); process.exit(1); });
