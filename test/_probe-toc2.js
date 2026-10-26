// 深挖：① MOBI7 NCX @r0+228 ② id=19 href 形态 ③ KF8 @e4.. 指向的记录内容
const path = require('path');
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

  // ---- ① MOBI7 NCX @228 ----
  for (const id of [19, 114]) {
    const b = db.getById(id);
    const recs = splitRecords(require('fs').readFileSync(b.path));
    const r0 = recs[0];
    // 候选：header 0xB4(r0+196)、0xE4(r0+244)、0xE8(r0+248)
    for (const off of [196, 244, 248]) {
      const idx = u32(r0, off);
      if (!(idx > 1 && idx < recs.length)) { console.log(`ncx@${off}=${idx} (skip)`); continue; }
      const ncx = recs[idx];
      console.log(`\n===== MOBI id=${id} ncx@${off}=${idx} magic=${ncx.toString('latin1', 0, 4)} len=${ncx.length}`);
      if (ncx.toString('latin1', 0, 4) !== 'INDX') continue;
      console.log('hex 0..48:', ncx.subarray(0, 48).toString('hex').replace(/(..)/g, '$1 '));
      const total = u32(ncx, 24);
      console.log('total@24:', total);
      const strs = ncx.toString('latin1').match(/[\x20-\x7e]{2,}/g) || [];
      console.log('strings:', strs.slice(0, 40));
      break;
    }
    // ② href 形态
    let hrefs = [];
    for (let i = 1; i < Math.min(recs.length, 60); i++) {
      const s = recs[i].toString('latin1');
      for (const m of (s.match(/href\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi) || [])) hrefs.push(m);
    }
    const uniq = [...new Set(hrefs)];
    console.log('href samples:', uniq.slice(0, 30));
    // 章节标题模式统计
    let chap = 0;
    for (let i = 1; i < recs.length; i++) {
      const s = recs[i].toString('latin1');
      chap += (s.match(/第[0-9一二三四五六七八九十百千零两]+[章节卷回部集]/g) || []).length;
    }
    console.log('章节字样出现:', chap);
  }

  // ---- ③ KF8 指向的记录 ----
  for (const id of [603, 2937]) {
    const b = db.getById(id);
    const recs = splitRecords(require('fs').readFileSync(b.path));
    const r0 = recs[0];
    console.log(`\n===== AZW3 id=${id} records=${recs.length}`);
    const cands = {};
    for (const off of [0xE4, 0xE8, 0xEC, 0xF0, 0xF4, 0xF8, 0xFC, 0xB0, 0xB4, 0xB8, 0xC0, 0xC4, 0xE0]) {
      const v = u32(r0, 16 + off);
      if (v > 0 && v < recs.length && !cands[v]) cands[v] = off.toString(16);
    }
    for (const [idxHex, fromOff] of Object.entries(cands)) {
      const idx = +idxHex;
      const r = recs[idx];
      const asc = r.subarray(0, 200).toString('latin1').replace(/[^\x20-\x7e]/g, '.');
      console.log(`rec${idx} (from hdr 0x${fromOff}) len=${r.length} head hex=${r.subarray(0, 32).toString('hex')}`);
      console.log('  asc:', asc.slice(0, 180));
    }
  }
})().catch(e => { console.error(e); process.exit(1); });
