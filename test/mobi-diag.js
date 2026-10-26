// 诊断：逐记录 PalmDoc 解压，定位失步点
const fs = require('fs');

function u16(b, o) { return b.readUInt16BE(o); }
function u32(b, o) { return b.readUInt32BE(o); }

const file = process.argv[2];
const buf = fs.readFileSync(file);

// splitRecords（与 lib/mobi.js 相同）
const numRecords = u16(buf, 76);
const offsets = [];
for (let i = 0; i < numRecords; i++) offsets.push(u32(buf, 78 + i * 8));
offsets.push(buf.length);
const records = [];
for (let i = 0; i < numRecords; i++) records.push(buf.subarray(offsets[i], offsets[i + 1]));

// header（r0）
const r0 = records[0];
const compression = u16(r0, 0);
const textLength = u32(r0, 4);
const numText = u16(r0, 8);
const encryption = u16(r0, 14);
const encoding = u32(r0, 28);
console.log({ compression, textLength, numText, encryption, encoding, numRecords });

// 当前实现的 palmdocDecompress（f1 标准公式）
function palmdocDecompress(input) {
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
      const pair = (c << 8) | input[i++];
      const dist = (pair & 0x7ff) + 1;
      const len = ((pair >> 11) & 7) + 3;
      let start = out.length - dist;
      if (start < 0) start = 0;
      for (let k = 0; k < len; k++) {
        const b = start + k < out.length ? out[start + k] : 0x20;
        out.push(b);
      }
    } else {
      out.push(0x20, c ^ 0x80);
    }
  }
  return Buffer.from(out);
}

// 逐记录解压，检查质量
const all = [];
for (let i = 1; i <= numText && i < records.length; i++) {
  const rec = records[i];
  const out = palmdocDecompress(rec);
  const html = encoding === 65001 ? out.toString('utf8') : out.toString('latin1');
  const bad = (html.match(/\uFFFD/g) || []).length;
  const frag = (html.match(/<ht<ht/g) || []).length;
  // 头部样例
  const head = html.slice(0, 90).replace(/\n/g, '\\n');
  console.log(`rec${i} in=${rec.length} out=${out.length} bad=${bad} frag=${frag} head=${JSON.stringify(head)}`);
  all.push(out);
}
const total = Buffer.concat(all);
console.log('total decompressed =', total.length, 'textLength =', textLength);
