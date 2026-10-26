// 插桩：统计 dist=0 与 start<0 的发生位置，并对照最终 FFFD 位置
const fs = require('fs');
function u16(b, o) { return b.readUInt16BE(o); }
function u32(b, o) { return b.readUInt32BE(o); }

const file = process.argv[2];
const buf = fs.readFileSync(file);
const numRecords = u16(buf, 76);
const offsets = [];
for (let i = 0; i < numRecords; i++) offsets.push(u32(buf, 78 + i * 8));
offsets.push(buf.length);
const records = [];
for (let i = 0; i < numRecords; i++) records.push(buf.subarray(offsets[i], offsets[i + 1]));
const r0 = records[0];
const textLength = u32(r0, 4);
const numText = u16(r0, 8);

function decompressInst(input, recIdx, events) {
  const out = [];
  const n = input.length;
  let i = 0;
  while (i < n) {
    const c = input[i++];
    if (c <= 8) {
      for (let k = 0; k < c && i < n; k++) out.push(input[i++]);
    } else if (c < 0x80) {
      out.push(c);
    } else if (c < 0xc0) {
      if (i >= n) break;
      const b = input[i++];
      const item = ((c & 0x3f) << 8) | b;
      const dist = item >> 3;
      const len = (item & 7) + 3;
      const start = out.length - dist;
      if (dist === 0) events.push({ rec: recIdx, pos: out.length, type: 'dist0', c, b });
      if (start < 0) events.push({ rec: recIdx, pos: out.length, type: 'underflow', dist, outLen: out.length });
      let s = start < 0 ? 0 : start;
      for (let k = 0; k < len; k++) {
        const bb = s + k < out.length ? out[s + k] : 0x20;
        out.push(bb);
      }
    } else {
      out.push(0x20, c ^ 0x80);
    }
  }
  return Buffer.from(out);
}

const events = [];
const parts = [];
for (let i = 1; i <= numText && i < records.length; i++) parts.push(decompressInst(records[i], i, events));
const total = Buffer.concat(parts).subarray(0, textLength);

console.log('dist0/underflow events =', events.length);
for (const e of events.slice(0, 30)) console.log(JSON.stringify(e));

const full = total.toString('utf8');
const ffdPos = [];
let ix = -1;
while ((ix = full.indexOf('\uFFFD', ix + 1)) !== -1) ffdPos.push(ix);
console.log('FFFD positions count =', ffdPos.length);
console.log('first FFDs:', ffdPos.slice(0, 20).join(','));

// 计算每个记录输出在 total 中的偏移，检查 FFFD 是否落在事件附近
let off = 0;
const recRanges = [];
for (let i = 0; i < parts.length; i++) { recRanges.push({ rec: i + 1, start: off, end: off + parts[i].length }); off += parts[i].length; }
for (const e of events) {
  const r = recRanges.find((x) => x.rec === e.rec);
  if (r) e.globalPos = r.start + e.pos;
}
console.log('global event pos:', events.map((e) => `${e.type}@${e.globalPos}`).join(' '));
// 每个 FFD 与最近事件距离
let near = 0;
for (const p of ffdPos) {
  let best = 1e9;
  for (const e of events) best = Math.min(best, Math.abs((e.globalPos || 0) - p));
  if (best <= 5) near++;
}
console.log(`FFFD within 5 bytes of an event: ${near}/${ffdPos.length}`);

// 打印 FFFD 上下文（前10个）与对应事件
for (const p of ffdPos.slice(0, 10)) {
  console.log(`ffd@${p}: ${JSON.stringify(full.slice(Math.max(0, p - 25), p + 25))}`);
}
