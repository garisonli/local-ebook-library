// 深挖 2：① record0 EXTH 后是否为 KF8 片段表 ② id=19 解压后章节形态 ③ 全库带 opts 复测+计时
const path = require('path');
const fs = require('fs');
const db = require('../lib/db');
const mobi = require('../lib/mobi');

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

  // ---- ① KF8 record0：EXTH 结束位置之后的内容 ----
  for (const id of [603, 2937]) {
    const b = db.getById(id);
    const recs = splitRecords(fs.readFileSync(b.path));
    const r0 = recs[0];
    const hl = u32(r0, 20);
    let exthStart = 16 + hl;
    if (r0.toString('latin1', exthStart, exthStart + 4) === 'EXTH') {
      const exthLen = u32(r0, exthStart + 4);
      const after = exthStart + exthLen;
      console.log(`\n===== AZW3 id=${id} r0.len=${r0.length} exthEnd=${after} tail=${r0.length - after}`);
      const tail = r0.subarray(after);
      console.log('tail hex 0..96:', tail.subarray(0, 96).toString('hex').replace(/(..)/g, '$1 '));
      console.log('tail asc:', tail.subarray(0, 200).toString('latin1').replace(/[^\x20-\x7e]/g, '.'));
      // 尝试按 (u32 recIdx, u32 off) 对数组解析
      if (tail.length >= 8) {
        const n1 = u32(tail, 0);
        console.log('u32@0 =', n1, '(records? fragment count?)');
        const n2 = tail.length >= 8 ? u32(tail, 4) : 0;
        console.log('u32@4 =', n2);
        // 每项 8 字节？
        if (n1 > 0 && n1 * 8 + 8 <= tail.length + 8) {
          const rows = [];
          for (let i = 0; i < Math.min(n1, 12); i++) {
            const p = 4 + i * 8; // 或 8 + i*8
            if (p + 8 <= tail.length) rows.push(`${u32(tail, p)},${u32(tail, p + 4)}`);
          }
          console.log('pairs from +4:', rows.join(' | '));
          const rows2 = [];
          for (let i = 0; i < Math.min(n1, 12); i++) {
            const p = 8 + i * 8;
            if (p + 8 <= tail.length) rows2.push(`${u32(tail, p)},${u32(tail, p + 4)}`);
          }
          console.log('pairs from +8:', rows2.join(' | '));
        }
      }
    }
  }

  // ---- ② id=19 解压后 HTML：开头 6000 字（跳过图片）+ 粗体/居中段落 ----
  {
    const b = db.getById(19);
    const { html } = mobi.parseHtml(b.path, {});
    const text = html.replace(/<img[^>]*>/gi, '[IMG]');
    console.log('\n===== id=19 html head (skip img):');
    console.log(text.slice(0, 6000));
  }

  // ---- ③ 全库带 opts（同应用链路）复测 ----
  console.log('\n===== 全库复测（imgDir 模式）=====');
  const books = db.allBooks("ext IN ('mobi','azw3','azw','prc','azw1')");
  const fails = [], slow = [];
  let ok = 0;
  for (const b of books) {
    const t0 = Date.now();
    try {
      const imgDir = path.join(userData, 'mobi-cache', `_t-${b.id}`);
      const r = mobi.parseHtml(b.path, { imgDir, imgUrl: (p) => 'elocal://x/' + p });
      const dt = Date.now() - t0;
      if (dt > 4000) slow.push({ id: b.id, title: b.title, dt });
      if (r.html.length < 200) fails.push({ id: b.id, title: b.title, reason: 'html 过短 ' + r.html.length });
      else ok++;
      // 清理临时图片目录
      try { fs.rmSync(imgDir, { recursive: true, force: true }); } catch (e) {}
    } catch (e) {
      fails.push({ id: b.id, title: b.title, reason: e.message });
    }
  }
  console.log('OK:', ok, 'FAIL:', fails.length, 'slow(>4s):', slow.length);
  for (const f of fails) console.log('FAIL', f.id, f.title, f.reason);
  for (const s of slow) console.log('SLOW', s.id, s.title, s.dt + 'ms');
})().catch(e => { console.error(e); process.exit(1); });
