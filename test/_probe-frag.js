// 经验探查 KF8 片段表：record0 尾部 / 全 record0 扫描 u32 对
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
  for (const id of [2937, 603]) {
    const b = db.getById(id);
    const recs = splitRecords(fs.readFileSync(b.path));
    const r0 = recs[0];
    const hl = u32(r0, 20);
    const exthStart = 16 + hl;
    const exthLen = u32(r0, exthStart + 4);
    const after = exthStart + exthLen;
    console.log(`\n===== id=${id} r0.len=${r0.length} afterExth=${after}`);
    // record0 中第一个非零 u32 位置（after 之后）
    for (let off = after; off + 4 <= r0.length; off += 4) {
      const v = u32(r0, off);
      if (v !== 0) { console.log('first nonzero u32 after EXTH @', off, '=', v); break; }
    }
    // record0 末 32 字节
    console.log('r0 tail32 hex:', r0.subarray(r0.length - 32).toString('hex').replace(/(..)/g, '$1 '));
    // 扫描 (recIdx, off) 对：recIdx∈[1,numText], off<200000, 连续≥10 对且 recIdx 非降
    const numText = u16(r0, 8);
    const best = [];
    for (let start = after; start + 8 <= r0.length; start += 4) {
      let cnt = 0, last = -1, p = start;
      const rows = [];
      while (p + 8 <= r0.length) {
        const ri = u32(r0, p), of = u32(r0, p + 4);
        if (ri < 1 || ri > numText + 10 || of > 300000 || ri < last) break;
        rows.push([ri, of]); last = ri; cnt++; p += 8;
      }
      if (cnt >= 12) { best.push({ start, cnt, head: rows.slice(0, 6) }); break; }
    }
    console.log('pair-array scan:', JSON.stringify(best));
    // 也扫描 16 字节项 (u32 u32 u32 u32)
    // 检查 r0 内是否有 base36 fid 字符串相邻? 跳过
    // 另一个思路：片段表可能在单独记录里——扫描所有记录找 (ri,off) 对数组
    if (!best.length) {
      outer:
      for (let i = 1; i < Math.min(recs.length, 20); i++) {
        const r = recs[i];
        for (let start = 0; start + 8 <= Math.min(r.length, 64); start += 4) {
          let cnt = 0, last = -1, p = start;
          const rows = [];
          while (p + 8 <= r.length) {
            const ri = u32(r, p), of = u32(r, p + 4);
            if (ri < 1 || ri > numText + 10 || of > 300000 || ri < last) break;
            rows.push([ri, of]); last = ri; cnt++; p += 8;
          }
          if (cnt >= 12) { console.log(`found in rec${i} @${start} cnt=${cnt} head=${JSON.stringify(rows.slice(0, 6))}`); break outer; }
        }
      }
      console.log('done scan other records');
    }
  }
})().catch(e => { console.error(e); process.exit(1); });
