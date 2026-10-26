// rec46 全 token 取证（目标输出 35 字节）
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
const numText = u16(records[0], 8);
const last = records[numText]; // 第46条
console.log('rec46 input len =', last.length, 'hex:');
console.log(last.toString('hex'));

const out = [];
let i = 0;
while (i < last.length) {
  const inOff = i;
  const c = last[i++];
  if (c <= 8) {
    const lit = last.subarray(i, i + c);
    console.log(`in@${inOff}: lit ${c} -> ${lit.toString('hex')} | out ${out.length}-${out.length + c} ${JSON.stringify(lit.toString('utf8'))}`);
    for (let k = 0; k < c && i < last.length; k++) out.push(last[i++]);
  } else if (c < 0x80) {
    console.log(`in@${inOff}: one 0x${c.toString(16)} '${String.fromCharCode(c)}' out ${out.length}`);
    out.push(c);
  } else if (c < 0xc0) {
    const b = last[i++];
    const item = ((c & 0x3f) << 8) | b;
    const dist = item >> 3;
    const len = (item & 7) + 3;
    const s = out.length - dist;
    const copied = [];
    for (let k = 0; k < len; k++) {
      const bb = (s + k >= 0 && s + k < out.length) ? out[s + k] : 0x20;
      copied.push(bb);
    }
    console.log(`in@${inOff}: copy c=0x${c.toString(16)} b=0x${b.toString(16)} dist=${dist} len=${len} -> out ${out.length}-${out.length + len} ${JSON.stringify(Buffer.from(copied).toString('utf8'))}`);
    for (const bb of copied) out.push(bb);
  } else {
    console.log(`in@${inOff}: pair c=0x${c.toString(16)} -> ' ${String.fromCharCode(c ^ 0x80)}' out ${out.length}`);
    out.push(0x20, c ^ 0x80);
  }
}
console.log('total out =', out.length, '(target 35)');
console.log('output:', JSON.stringify(Buffer.from(out).toString('utf8')));
