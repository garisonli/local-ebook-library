// 决定性探针2：① kindle:pos 的 off 是否 base36 片段内偏移 ② filepos 是否字节偏移
const path = require('path');
const fs = require('fs');
const db = require('../lib/db');
const mobi = require('../lib/mobi');

function b36(s) { return parseInt(String(s), 36); }
function norm(s) { return s.replace(/[\s\u3000]+/g, ''); }

const userData = path.join(process.env.APPDATA, 'local-ebook-library');
(async () => {
  await db.init(userData);

  // ---- ① AZW3 kindle:pos off 语义 ----
  for (const id of [2937, 603]) {
    const b = db.getById(id);
    const { html } = mobi.parseHtml(b.path, {});
    const nhtml = norm(html);
    console.log(`\n===== id=${id}`);
    const links = [];
    const re = /<a\s+[^>]*href\s*=\s*["']kindle:pos:fid:([^"':]+):off:([0-9A-Za-z]+)["']\s*[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(html))) {
      const label = m[3].replace(/<[^>]+>/g, '').trim();
      if (label.length >= 2) links.push({ fid: m[1], off: b36(m[2]), label, pos: m.index });
    }
    const starts = [...html.matchAll(/<html[\s>]/gi)].map((x) => x.index);
    // 对每个链接：找 label 第一次出现在链接区之后的位置
    const byFid = {};
    let checked = 0;
    for (const l of links) {
      const nl = norm(l.label);
      if (!nl) continue;
      const p = nhtml.indexOf(nl, l.pos + 200);
      if (p < 0) continue;
      checked++;
      // char index → byte index
      const bytePos = Buffer.byteLength(html.slice(0, p), 'utf8');
      (byFid[l.fid] = byFid[l.fid] || []).push({ off: l.off, charPos: p, bytePos, label: l.label.slice(0, 18) });
    }
    console.log('checked', checked, 'of', links.length);
    // 每 fid：bytePos - off 应为常数（=片段起点，字节）
    let consistent = 0, inconsistent = 0;
    for (const [fid, arr] of Object.entries(byFid)) {
      if (arr.length < 2) continue;
      const bases = arr.map((x) => x.bytePos - x.off);
      const spread = Math.max(...bases) - Math.min(...bases);
      if (spread <= 4) consistent++; else { inconsistent++; if (inconsistent <= 4) console.log(` fid=${fid} spread=${spread}`, arr.map((x) => `off${x.off}->b${x.bytePos}(base ${x.bytePos - x.off})`).join(' ')); }
    }
    console.log('per-fid base consistent:', consistent, 'inconsistent:', inconsistent);
    // 展示几个多链接 fid 的 base 与 html 块起点关系
    let shown = 0;
    for (const [fid, arr] of Object.entries(byFid)) {
      if (arr.length < 3 || shown >= 3) continue;
      shown++;
      const bases = arr.map((x) => x.bytePos - x.off);
      const base = bases[Math.floor(bases.length / 2)];
      const nearest = starts.map((s, i) => ({ i, d: Math.abs(s - base) })).sort((a, b2) => a.d - b2.d)[0];
      console.log(` fid=${fid} n=${arr.length} base≈${base} nearestHtmlBlock=${nearest.i}@${starts[nearest.i]} delta=${nearest.d}`);
    }
    // off=0 的链接：label 位置 == 片段起点？
    const off0 = Object.entries(byFid).filter(([, arr]) => arr.length && arr[0].off === 0).slice(0, 5);
    for (const [fid, arr] of off0) {
      const x = arr[0];
      const nearest = starts.map((s, i) => ({ i, d: Math.abs(s - x.bytePos) })).sort((a, b2) => a.d - b2.d)[0];
      console.log(` off0 fid=${fid} labelByte=${x.bytePos} nearestBlock=${nearest.i}@${starts[nearest.i]} d=${nearest.d} "${x.label}"`);
    }
  }

  // ---- ② MOBI7 filepos 字节偏移验证 ----
  {
    const b = db.getById(19);
    const { html } = mobi.parseHtml(b.path, {});
    const links = [...html.matchAll(/<a\s+filepos=(\d{10})>([\s\S]*?)<\/a>/gi)].slice(0, 8);
    console.log('\n===== id=19 filepos 验证, links:', links.length);
    for (const mm of links) {
      const fp = parseInt(mm[1], 10);
      const label = mm[2].replace(/<[^>]+>/g, '');
      const pos = html.indexOf(norm(label), 5000); // 跳过目录页自身
      const bytePos = pos >= 0 ? Buffer.byteLength(html.slice(0, pos), 'utf8') : -1;
      console.log(` filepos=${fp} label="${label.slice(0, 16)}" firstBodyOccur char=${pos} byte=${bytePos} delta=${bytePos - fp}`);
    }
  }
})().catch(e => { console.error(e); process.exit(1); });
