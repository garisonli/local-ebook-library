// v3 公式逐记录质量 + 坏字符上下文
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

function palmdocV3(input) {
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
      let start = out.length - dist;
      if (start < 0) start = 0;
      for (let k = 0; k < len; k++) {
        const bb = start + k < out.length ? out[start + k] : 0x20;
        out.push(bb);
      }
    } else {
      out.push(0x20, c ^ 0x80);
    }
  }
  return Buffer.from(out);
}

const all = [];
let badTotal = 0;
for (let i = 1; i <= numText && i < records.length; i++) {
  const out = palmdocV3(records[i]);
  const html = out.toString('utf8');
  const bad = html.match(/\uFFFD/g) || [];
  badTotal += bad.length;
  all.push(out);
  if (bad.length) {
    // 打印前3个坏字符上下文
    const spots = [];
    let idx = -1;
    while (spots.length < 3 && (idx = html.indexOf('\uFFFD', idx + 1)) !== -1) spots.push(idx);
    for (const s of spots) {
      console.log(`rec${i} bad@${s}: ${JSON.stringify(html.slice(Math.max(0, s - 30), s + 30))}`);
    }
    console.log(`rec${i} bad=${bad.length}`);
  } else {
    console.log(`rec${i} bad=0 head=${JSON.stringify(html.slice(0, 70))}`);
  }
}
const total = Buffer.concat(all);
console.log('badTotal =', badTotal, ' total =', total.length, ' textLength =', textLength);
const full = total.subarray(0, textLength).toString('utf8');
console.log('FFFD after trim =', (full.match(/\uFFFD/g) || []).length);
console.log('tail:', JSON.stringify(full.slice(-120)));
console.log('sample:', JSON.stringify(full.slice(3000, 3400)));
