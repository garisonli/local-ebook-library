// 综合探针：① SKEL 魔数 ② INDX 链 ③ NCX XML ④ <html 出现次数
const path = require('path');
const fs = require('fs');
const db = require('../lib/db');

function u16(b, o) { return b.readUInt16BE(o); }
function u32(b, o) { return b.readUInt32BE(o); }
function splitRecords(buf) {
  const n = u16(buf, 76);
  const offs = [];
  for (let i = 0; i < n; i++) offs.push(u32(buf, 78 + i * 8));
  offs.push(buf.length);
  const recs = [];
  for (let i = 0; i < n; i++) recs.push(buf.subarray(offs[i], offs[i + 1]));
  return recs;
}

const userData = path.join(process.env.APPDATA, 'local-ebook-library');
(async () => {
  await db.init(userData);

  // ---- ① AZW3 记录魔数清单 + SKEL 搜索 ----
  for (const id of [2937, 603]) {
    const b = db.getById(id);
    const recs = splitRecords(fs.readFileSync(b.path));
    console.log(`\n===== AZW3 id=${id} records=${recs.length}`);
    const magics = {};
    for (let i = 0; i < recs.length; i++) {
      const m = recs[i].toString('latin1', 0, 4);
      if (/^[A-Z]{4}$/.test(m)) { (magics[m] = magics[m] || []).push(i); }
    }
    for (const [m, idxs] of Object.entries(magics)) console.log(`  ${m}: ${idxs.length} recs, first: ${idxs.slice(0, 6)} last: ${idxs.slice(-3)}`);
    // SKEL 详情
    if (recs.some((r) => r.toString('latin1', 0, 4) === 'SKEL')) {
      const i = recs.findIndex((r) => r.toString('latin1', 0, 4) === 'SKEL');
      const r = recs[i];
      console.log(`  SKEL rec${i} len=${r.length} head:`, r.subarray(0, 48).toString('hex').replace(/(..)/g, '$1 '));
      const n = u32(r, 8);
      console.log('  SKEL u32@8 =', n, ' u32@12 =', u32(r, 12));
      // 尝试 12 字节项 (u32 u32 u32)
      const rows = [];
      for (let k = 0; k < 8; k++) {
        const p = 16 + k * 12;
        if (p + 12 <= r.length) rows.push(`${u32(r, p)},${u32(r, p + 4)},${u32(r, p + 8)}`);
      }
      console.log('  SKEL 12B rows from @16:', rows.join(' | '));
      const rows2 = [];
      for (let k = 0; k < 8; k++) {
        const p = 24 + k * 12;
        if (p + 12 <= r.length) rows2.push(`${u32(r, p)},${u32(r, p + 4)},${u32(r, p + 8)}`);
      }
      console.log('  SKEL 12B rows from @24:', rows2.join(' | '));
    } else console.log('  no SKEL');
    // FDST 详情
    const fi = recs.findIndex((r) => r.toString('latin1', 0, 4) === 'FDST');
    if (fi >= 0) {
      const r = recs[fi];
      console.log(`  FDST rec${fi} len=${r.length}:`, r.subarray(0, Math.min(r.length, 64)).toString('hex').replace(/(..)/g, '$1 '));
    }
  }

  // ---- ② MOBI7 INDX@244 完整转储（utf8 片段）+ NCX XML 搜索 ----
  for (const id of [19, 114]) {
    const b = db.getById(id);
    const recs = splitRecords(fs.readFileSync(b.path));
    const r0 = recs[0];
    const idx = u32(r0, 244);
    console.log(`\n===== MOBI id=${id} INDX rec${idx}`);
    const r = recs[idx];
    console.log('full hex:', r.toString('hex').replace(/(..)/g, '$1 '));
    console.log('as utf8:', r.toString('utf8').replace(/[^\x20-\x7e\u4e00-\u9fff]/g, '.'));
    // 全记录搜索 ncx/navPoint/NBX
    for (let i = 0; i < recs.length; i++) {
      const s = recs[i].toString('latin1');
      if (/navPoint|<ncx|NBX |skel|SKEL/i.test(s)) console.log(`  rec${i} contains nav/ncx keyword, len=${recs[i].length}, head=${s.slice(0, 80).replace(/[^\x20-\x7e]/g, '.')}`);
    }
  }

  // ---- ③ 603 解压 html 中 <?xml / <html 出现次数 ----
  {
    const mobi = require('../lib/mobi');
    const b = db.getById(603);
    const { html } = mobi.parseHtml(b.path, {});
    const xmls = [...html.matchAll(/<\?xml/g)].length;
    const htmls = [...html.matchAll(/<html[\s>]/gi)].length;
    const bodies = [...html.matchAll(/<body[\s>]/gi)].length;
    console.log(`\n===== 603 decompressed: <?xml=${xmls} <html=${htmls} <body=${bodies} len=${html.length}`);
    // <html 出现位置
    const positions = [...html.matchAll(/<html[\s>]/gi)].map((m) => m.index);
    console.log('<html positions:', positions.slice(0, 20).join(','));
  }
})().catch(e => { console.error(e); process.exit(1); });
