// 验证 HUFF/CDIC 解码 + 1391 大书修复
const fs = require('fs');
const path = require('path');
const db = require('../lib/db');
const mobi = require('../lib/mobi');

(async () => {
  await db.init(path.join(process.env.APPDATA, 'local-ebook-library'));
  const ids = [4860, 2937, 3099, 3126, 3946, 3974, 4025, 1391];
  let pass = 0, fail = 0;
  for (const id of ids) {
    const b = db.getById(id);
    if (!b) { console.log('SKIP', id); continue; }
    const t0 = Date.now();
    try {
      const imgDir = path.join(__dirname, '_vimgs-' + id);
      const r = mobi.parseHtml(b.path, {
        imgDir,
        imgUrl: (p) => 'elocal://f/' + String(p).replace(/\\/g, '/').replace(/^\//, ''),
      });
      const html = r.html;
      const fffd = (html.match(/\uFFFD/g) || []).length;
      const tags = (html.match(/<[a-zA-Z!?/]/g) || []).length;
      // 采样正文（去掉内嵌 data: 噪音后取前 200 字符的可见文本）
      const text = html.replace(/data:[^"']*/g, 'DATA').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const head = text.slice(0, 100);
      const ms = Date.now() - t0;
      const imgRefs = (html.match(/elocal:\/\/f\//g) || []).length;
      const dataUris = (html.match(/data:image\//g) || []).length;
      console.log(`PASS id=${id} len=${html.length} tags=${tags} fffd=${fffd} toc=${r.toc.length} imgDisk=${imgRefs} imgB64=${dataUris} ${ms}ms`);
      console.log('  head:', JSON.stringify(head));
      if (tags < 10 || fffd > html.length * 0.01) { console.log('  !! 质量可疑'); fail++; } else pass++;
    } catch (e) {
      fail++;
      console.log(`FAIL id=${id}: ${e.message}`);
      console.log('  ', String(e.stack).split('\n').slice(1, 4).join('\n   '));
    }
  }
  console.log(`\n结果: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
