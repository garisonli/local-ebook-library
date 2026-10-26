// 诊断：① 无目录 MOBI 的 HTML 结构 ② AZW3 缓存里的外链形态
const path = require('path');
const os = require('os');
const fs = require('fs');
const db = require('../lib/db');
const mobi = require('../lib/mobi');

const userData = path.join(process.env.APPDATA, 'local-ebook-library');
const cacheDir = path.join(userData, 'mobi-cache');

(async () => {
  await db.init(userData);

  // ---- ① 无 h 目录的 MOBI：dump 前 4000 字符看结构 ----
  const b19 = db.getById(19);
  if (b19) {
    const r = mobi.parseHtml(b19.path, {});
    const body = r.html.match(/<body[^>]*>([\s\S]*)/i);
    const head = (body ? body[1] : r.html).slice(0, 4500);
    console.log('===== MOBI id=19 toc=', r.toc.length, 'len=', r.html.length);
    console.log(head);
    // 统计 a 标签锚点
    const anchors = r.html.match(/<a\b[^>]*href\s*=\s*["']#[^"']+["'][^>]*>/gi) || [];
    console.log('\n--- in-page anchor links:', anchors.length);
    console.log(anchors.slice(0, 12).join('\n'));
  }

  // ---- ② AZW3 外链形态：找几本 AZW3 看缓存/解析出的外链 ----
  const azw3 = db.allBooks("ext='azw3'").slice(0, 6);
  for (const b of azw3) {
    const f = path.join(cacheDir, `v3-${b.id}-${Math.floor(b.mtime || 0)}.html`);
    let html;
    if (fs.existsSync(f)) html = fs.readFileSync(f, 'utf8');
    else html = mobi.parseHtml(b.path, {}).html;
    const ext = html.match(/<a\b[^>]*href\s*=\s*["']https?:\/\/[^"']+["'][^>]*>/gi) || [];
    const kindle = html.match(/<a\b[^>]*href\s*=\s*["']kindle:[^"']+["'][^>]*>/gi) || [];
    const frag = html.match(/<a\b[^>]*href\s*=\s*["']#[^"']+["'][^>]*>/gi) || [];
    console.log(`\n===== AZW3 id=${b.id} [${String(b.title).slice(0,20)}] extLinks=${ext.length} kindleLinks=${kindle.length} fragLinks=${frag.length}`);
    if (ext.length) console.log('ext sample:', ext.slice(0, 5).join('\n'));
    if (kindle.length) console.log('kindle sample:', kindle.slice(0, 3).join('\n'));
    if (frag.length) console.log('frag sample:', frag.slice(0, 5).join('\n'));
  }
})().catch(e => { console.error(e); process.exit(1); });
