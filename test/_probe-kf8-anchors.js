// 探针：AZW3 目录页 kindle:pos 链接 vs 正文 id 锚点的对应关系
const path = require('path');
const fs = require('fs');
const db = require('../lib/db');
const mobi = require('../lib/mobi');

const userData = path.join(process.env.APPDATA, 'local-ebook-library');
(async () => {
  await db.init(userData);
  for (const id of [603, 2937]) {
    const b = db.getById(id);
    const { html } = mobi.parseHtml(b.path, {});
    console.log(`\n===== AZW3 id=${id} len=${html.length}`);
    // 所有 kindle:pos 链接
    const links = [...html.matchAll(/<a\s+[^>]*href\s*=\s*["']kindle:pos:fid:([^"':]+):off:([0-9A-Za-z]+)["']([^>]*)>/gi)]
      .map((m) => ({ fid: m[1], off: m[2], rest: m[3] }));
    console.log('kindle:pos links:', links.length, 'first 15:', links.slice(0, 15).map((l) => l.fid + ':' + l.off).join(' '));
    // 目录链接的位置分布：前 30 个链接在 html 中的偏移
    const positions = [];
    const re = /href\s*=\s*["']kindle:pos:fid:/gi;
    let m;
    while ((m = re.exec(html)) && positions.length < 40) positions.push(m.index);
    console.log('link offsets first 40:', positions.slice(0, 40).join(','));
    // 间距大 = 目录区结束
    const gaps = [];
    for (let i = 1; i < positions.length; i++) gaps.push(positions[i] - positions[i - 1]);
    console.log('gaps:', gaps.join(','));

    // 正文中的 id 锚点（无 href 的 a / 带 id 的元素）
    const ids = [...html.matchAll(/<(?:a|div|p|span|h[1-6])\s+[^>]*\bid\s*=\s*["']([^"']+)["']/gi)].map((x) => x[1]);
    console.log('id anchors:', ids.length, 'first 30:', ids.slice(0, 30).join(','));
    // 特殊：calibre 生成的 filepos 锚点？
    const fileposIds = ids.filter((x) => /filepos|pos|fid/i.test(x));
    console.log('filepos-like ids:', fileposIds.length, fileposIds.slice(0, 10));
    // name 锚点
    const names = [...html.matchAll(/<a\s+[^>]*\bname\s*=\s*["']([^"']+)["']/gi)].map((x) => x[1]);
    console.log('a name anchors:', names.length, 'first 20:', names.slice(0, 20).join(','));
    // <a id= 且内容为空（纯锚点）
    const pureAnchors = [...html.matchAll(/<a\s+[^>]*\bid\s*=\s*["']([^"']+)["'][^>]*>\s*<\/a>/gi)].map((x) => x[1]);
    console.log('pure <a id></a>:', pureAnchors.length, pureAnchors.slice(0, 20).join(','));
  }
})().catch(e => { console.error(e); process.exit(1); });
