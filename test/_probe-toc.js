// 探针：① MOBI NCX（r0+196）② AZW3 KF8 片段表 / 正文锚点形态
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

  // ---- ① MOBI NCX ----
  for (const id of [19, 114]) {
    const b = db.getById(id);
    const buf = require('fs').readFileSync(b.path);
    const recs = splitRecords(buf);
    const r0 = recs[0];
    // INDX/NCX 记录号候选：MOBI 头 0xD8（r0+232）；KF8 另有 0xE4（r0+248）
    const ncxCands = [196, 232, 248, 216].map((off) => ({ off, v: r0.length > off + 4 ? u32(r0, off) : 0 }));
    console.log(`\n===== MOBI id=${id} [${b.title}] records=${recs.length} numText=${u16(r0, 8)} ncxCands=` +
      ncxCands.map((c) => `@${c.off}=${c.v}`).join(' '));
    // <a name= 计数
    // 不解全文，抽查前 30 条文本记录
    const nameHits = [];
    for (let i = 1; i < Math.min(recs.length, 40); i++) {
      const s = recs[i].toString('latin1');
      const m = s.match(/<a\s+name="[^"]+"/gi);
      if (m) nameHits.push(...m.slice(0, 3));
    }
    console.log('a[name] samples in raw records:', nameHits.length, nameHits.slice(0, 6));
    for (const c of ncxCands) {
      const ncxIdx = c.v;
      if (!(ncxIdx > 0 && ncxIdx < recs.length)) continue;
      const ncx = recs[ncxIdx];
      console.log(`-- try @${c.off} ncxIdx=${ncxIdx} magic=${ncx.toString('latin1', 0, 4)} len=${ncx.length}`);
      if (ncx.toString('latin1', 0, 4) !== 'INDX') continue;
      // INDX 头 16 字节
      console.log('INDX head:', ncx.subarray(0, 16).toString('hex').replace(/(..)/g, '$1 '));
      const total = u32(ncx, 8);
      const ordNum = ncx.length > 24 ? u32(ncx, 24) : 0;
      console.log('total entries:', total, 'ordNum@24:', ordNum);
      const strs = ncx.toString('latin1').match(/[\x20-\x7e]{3,}/g) || [];
      console.log('strings sample:', strs.slice(0, 30));
      const seg = ncx.subarray(28, Math.min(ncx.length, 28 + 220));
      console.log('body hex:', seg.toString('hex').replace(/(..)/g, '$1 '));
      console.log('body asc:', seg.toString('latin1').replace(/[^\x20-\x7e]/g, '.'));
      break;
    }
  }

  // ---- ② AZW3 KF8 ----
  for (const id of [603, 2937]) {
    const b = db.getById(id);
    const buf = require('fs').readFileSync(b.path);
    const recs = splitRecords(buf);
    console.log(`\n===== AZW3 id=${id} [${b.title}] records=${recs.length}`);
    // 找所有 MOBI 头记录
    for (let i = 0; i < Math.min(recs.length, 8); i++) {
      const r = recs[i];
      if (r.length > 100 && r.toString('latin1', 16, 20) === 'MOBI') {
        const hl = u32(r, 20);
        const ver = u32(r, 36);
        console.log(`  rec${i}: MOBI ver=${ver} hdrLen=${hl} len=${r.length}`);
        // 打印 0x80..hdrLen 区域的 u32
        const fields = [];
        for (let off = 16 + 0x80; off + 4 <= 16 + hl && off + 4 <= r.length; off += 4) {
          fields.push(`@${(off - 16).toString(16)}=${u32(r, off)}`);
        }
        console.log('  fields 0x80+:', fields.join(' '));
        // record0 尾部（EXTH 之后可能有片段表）
        console.log('  rec tail 128 asc:', r.subarray(Math.max(0, r.length - 128)).toString('latin1').replace(/[^\x20-\x7e]/g, '.'));
      }
    }
    // 正文锚点形态：扫描文本记录中 id= / aid= / name= 的 <a> 与 <div>
    const aidSamples = [], idSamples = [], nameSamples = [];
    let textRecs = 0;
    for (let i = 1; i < recs.length && textRecs < 60; i++) {
      const s = recs[i].toString('latin1');
      if (!/[<>]/.test(s)) continue;
      textRecs++;
      for (const m of (s.match(/<a\s+[^>]*\baid="[^"]+"[^>]*>/gi) || [])) if (aidSamples.length < 6 && !/href=/i.test(m)) aidSamples.push(m);
      for (const m of (s.match(/<[a-z]+\s+[^>]*\bid="[^"]+"[^>]*>/gi) || [])) if (idSamples.length < 8) idSamples.push(m);
      for (const m of (s.match(/<a\s+[^>]*\bname="[^"]+"[^>]*>/gi) || [])) if (nameSamples.length < 6) nameSamples.push(m);
    }
    console.log('  anchor w/o href aid samples:', aidSamples);
    console.log('  id= element samples:', idSamples);
    console.log('  a name= samples:', nameSamples);
  }
})().catch(e => { console.error(e); process.exit(1); });
