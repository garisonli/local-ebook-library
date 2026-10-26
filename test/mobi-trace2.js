// rec2 token 级取证 + PalmDoc 头字段
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
console.log('PalmDoc hdr:', {
  compression: u16(r0, 0), unused: u16(r0, 2), textLength: u32(r0, 4),
  recordCount: u16(r0, 8), maxRecordSize: u16(r0, 10), encryption: u16(r0, 12), reserved: u16(r0, 14),
});

// rec2 v3 token trace，记录每个 token 的输出区间，dump out 1280-1400 附近的 token
const rec = records[2]; // rec2
const out = [];
const tokens = []; // {inOff, c, b, type, dist, len, outStart}
let i = 0;
while (i < rec.length) {
  const inOff = i;
  const c = rec[i++];
  const t = { inOff, c, outStart: out.length };
  if (c <= 8) {
    t.type = 'lit';
    t.len = c;
    for (let k = 0; k < c && i < rec.length; k++) out.push(rec[i++]);
  } else if (c < 0x80) {
    t.type = 'one';
    t.len = 1;
    out.push(c);
  } else if (c < 0xc0) {
    if (i >= rec.length) break;
    const b = rec[i++];
    const item = ((c & 0x3f) << 8) | b;
    t.type = 'copy';
    t.b = b;
    t.dist = item >> 3;
    t.len = (item & 7) + 3;
    let s = out.length - t.dist;
    if (s < 0) s = 0;
    for (let k = 0; k < t.len; k++) {
      const bb = s + k < out.length ? out[s + k] : 0x20;
      out.push(bb);
    }
  } else {
    t.type = 'pair';
    t.len = 2;
    out.push(0x20, c ^ 0x80);
  }
  t.outEnd = out.length;
  tokens.push(t);
}
const outBuf = Buffer.from(out);
console.log('rec2 out length =', outBuf.length);

// 找第一个坏 UTF-8 / FFFD 的输出位置
const s = outBuf.toString('utf8');
const f1 = s.indexOf('\uFFFD');
console.log('first FFFD at char', f1);
// 字符偏移->字节偏移
const bytePos = Buffer.from(s.slice(0, f1), 'utf8').length;
console.log('first FFFD at byte', bytePos);
// 打印覆盖该区域的 token
const hit = tokens.filter((t) => t.outStart <= bytePos + 10 && t.outEnd >= bytePos - 10);
for (const t of hit) {
  console.log(JSON.stringify(t), 'inputBytes=', rec.subarray(t.inOff, t.inOff + 6).toString('hex'));
}
// 输出 1270-1400 hex
console.log('out hex 1270..1400:', outBuf.subarray(1270, 1400).toString('hex'));
console.log('out txt 1270..1400:', JSON.stringify(outBuf.subarray(1270, 1400).toString('utf8')));
