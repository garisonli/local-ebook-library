// 多变体 PalmDoc 解压对拍：以 totalLength≈textLength、U+FFFD、HTML 片段数为指标
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

// 生成 token 处理函数的变体集合
// 每个变体: f(c, b, out) => {len, dist} 或 f 返回 null 表示非该 token
const variants = {
  // V1: 标准 [3 len][11 dist] (calibre/libmobi): dist=((c&7)<<8|b)+1, len=(c>>3)&7+3
  v1: (c, b) => ({ dist: (((c & 7) << 8) | b) + 1, len: ((c >> 3) & 7) + 3 }),
  // V2: wiki 字面序 [11 dist][3 len]: 14bit=(c&0x3F)<<8|b, dist=item>>3+1, len=item&7+3
  v2: (c, b) => { const item = ((c & 0x3f) << 8) | b; return { dist: (item >> 3) + 1, len: (item & 7) + 3 }; },
  // V3: V2 距离不+1
  v3: (c, b) => { const item = ((c & 0x3f) << 8) | b; return { dist: item >> 3, len: (item & 7) + 3 }; },
  // V4: V1 距离不+1
  v4: (c, b) => ({ dist: ((c & 7) << 8) | b, len: ((c >> 3) & 7) + 3 }),
  // V5: 字节交换 pair=(b<<8)|c
  v5: (c, b) => { const pair = (b << 8) | c; return { dist: (pair & 0x7ff) + 1, len: ((pair >> 11) & 7) + 3 }; },
  // V6: V5 的 wiki 序
  v6: (c, b) => { const item = ((b & 0x3f) << 8) | c; return { dist: (item >> 3) + 1, len: (item & 7) + 3 }; },
  // V7: len 从低3位 v1 +3 但 dist 用 c 低3位在低 (即 v1 但 len/dist 14位内互换 = 高11dist)
  v7: (c, b) => { const item = ((c & 0x3f) << 8) | b; return { dist: (item & 0x7ff) + 1, len: ((item >> 11) & 7) + 3 }; },
  // V8: dist = ((c&0x3F)<<8|b)>>3 无+1, len=(item&7)+3 但 len +2?
  v8: (c, b) => { const item = ((c & 0x3f) << 8) | b; return { dist: item >> 3, len: (item & 7) + 4 }; },
  // V9: v1 但 len +2 (长度2-9)
  v9: (c, b) => ({ dist: (((c & 7) << 8) | b) + 1, len: ((c >> 3) & 7) + 2 }),
  // V10: v1 len 不变 dist+0 但 len+3 -> 就是 v4 与 v1 之间: dist=...+1 同 v1; 改 len 高位从 c>>4
  v10: (c, b) => ({ dist: (((c & 0xf) << 8) | b) + 1, len: ((c >> 4) & 7) + 3 }),
  // V11: item=(c&0x3F)<<8|b, dist=(item&0x7FF), len=(item>>11)+3 (v7 无+1)
  v11: (c, b) => { const item = ((c & 0x3f) << 8) | b; return { dist: item & 0x7ff, len: ((item >> 11) & 7) + 3 }; },
  // V12: 距离含 pair 高位: dist=((c&0x3F)<<8|b)+1 超11位(不掩码), len=((c>>3)&7)+3? 不合理,略
};

function decompress(input, f) {
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
      const { dist, len } = f(c, b);
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

function stats(fn) {
  const parts = [];
  let ffd = 0, align = 0, width = 0, ptag = 0, frag = 0;
  for (let i = 1; i <= numText && i < records.length; i++) {
    const out = decompress(records[i], fn);
    parts.push(out);
    const s = out.toString('binary'); // latin1 计数即可
    ffd += 0; // binary 无 FFFD，改为字节级校验
    // utf8 校验
    const u = out.toString('utf8');
    ffd += (u.match(/\uFFFD/g) || []).length;
    align += (u.match(/align=/g) || []).length;
    width += (u.match(/width=/g) || []).length;
    ptag += (u.match(/<p /g) || []).length;
    frag += (u.match(/<ht<ht/g) || []).length;
  }
  const total = Buffer.concat(parts);
  // 无效 UTF-8 字节数：重编码后差异
  const rt = Buffer.from(total.toString('utf8'), 'utf8');
  return {
    total: total.length, ffd, align, width, ptag, frag,
    ratio: (total.length / textLength).toFixed(4),
  };
}

console.log('textLength =', textLength, ' numText =', numText);
for (const [name, f] of Object.entries(variants)) {
  try {
    const s = stats(f);
    console.log(name, JSON.stringify(s));
  } catch (e) { console.log(name, 'ERR', e.message); }
}
