// 最终验证：v3 公式 + cap 4096 + concat + textLength 截断
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
const maxRecordSize = u16(r0, 10) || 4096;

function palmdocDecompress(input, cap) {
  const out = [];
  const n = input.length;
  let i = 0;
  while (i < n && out.length < cap) {
    const c = input[i++];
    if (c <= 8) {
      for (let k = 0; k < c && i < n && out.length < cap; k++) out.push(input[i++]);
    } else if (c < 0x80) {
      out.push(c);
    } else if (c < 0xc0) {
      if (i >= n) break;
      const b = input[i++];
      const item = ((c & 0x3f) << 8) | b;
      const dist = item >> 3;
      const len = (item & 7) + 3;
      let s = out.length - dist;
      if (s < 0) s = 0;
      for (let k = 0; k < len && out.length < cap; k++) {
        const bb = s + k < out.length ? out[s + k] : 0x20;
        out.push(bb);
      }
    } else {
      out.push(0x20, c ^ 0x80);
    }
  }
  return Buffer.from(out);
}

const parts = [];
for (let i = 1; i <= numText; i++) parts.push(palmdocDecompress(records[i], maxRecordSize));
// 每记录尾部字节（检查是否被 pair 规则截出空格）
for (let i = 0; i < parts.length; i++) {
  const p = parts[i];
  const tail = p.subarray(Math.max(0, p.length - 4));
  if (tail[tail.length - 1] === 0x20) console.log(`warn: rec${i + 1} tail ends with space: ${tail.toString('hex')}`);
}
const total = Buffer.concat(parts);
console.log('total =', total.length, ' textLength =', textLength);
const trimmed = total.subarray(0, textLength);
const html = trimmed.toString('utf8');
console.log('FFFD =', (html.match(/\uFFFD/g) || []).length);
console.log('frag <ht<ht =', (html.match(/<ht<ht/g) || []).length);
console.log('head:', JSON.stringify(html.slice(0, 200)));
console.log('tail:', JSON.stringify(html.slice(-200)));
console.log('sample1:', JSON.stringify(html.slice(3000, 3400)));
console.log('sample2:', JSON.stringify(html.slice(90000, 90400)));
