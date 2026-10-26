// 验证：每记录输出在何处达到 4096 / 35，之后还剩多少输入字节
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
const textLength = u32(records[0], 4);
const numText = u16(records[0], 8);

function decodeToCap(input, cap) {
  // 输出达到 cap 即停，返回 {outLen, inPos, stopped}
  const out = [];
  let i = 0;
  while (i < input.length && out.length < cap) {
    const c = input[i++];
    if (c <= 8) {
      for (let k = 0; k < c && i < input.length && out.length < cap; k++) out.push(input[i++]);
    } else if (c < 0x80) {
      out.push(c);
    } else if (c < 0xc0) {
      if (i >= input.length) break;
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
      if (out.length + 1 >= cap) { out.push(0x20); } // 可能截断在空格处
      else out.push(0x20, c ^ 0x80);
      if (out.length > cap) out.length = cap;
    }
  }
  return { outLen: out.length, inPos: i, full: out.length >= cap };
}

let ok = 0;
for (let r = 1; r <= numText; r++) {
  const cap = r === numText ? textLength - 4096 * (numText - 1) : 4096;
  const rec = records[r];
  const d = decodeToCap(rec, cap);
  const left = rec.length - d.inPos;
  if (d.outLen === cap) ok++;
  const head = rec.subarray(0, 6).toString('hex');
  const tail = rec.subarray(Math.max(0, rec.length - 10)).toString('hex');
  const rest = rec.subarray(d.inPos).toString('hex');
  console.log(`rec${r} inLen=${rec.length} cap=${cap} out=${d.outLen} inStop=${d.inPos} left=${left} head=${head} rest=${rest}`);
}
console.log(`records reaching exact cap: ${ok}/${numText}`);
