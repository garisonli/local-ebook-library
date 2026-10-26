// 决定性探针：KF8 fid 是否 = base36(HTML 块序号) + off = base36(块内偏移)
const path = require('path');
const fs = require('fs');
const db = require('../lib/db');
const mobi = require('../lib/mobi');

function b36(s) { return parseInt(String(s), 36); }

const userData = path.join(process.env.APPDATA, 'local-ebook-library');
(async () => {
  await db.init(userData);
  for (const id of [2937, 603]) {
    const b = db.getById(id);
    const { html } = mobi.parseHtml(b.path, {});
    console.log(`\n===== id=${id} len=${html.length}`);
    // HTML 块起点
    const starts = [...html.matchAll(/<html[\s>]/gi)].map((m) => m.index);
    console.log('html blocks:', starts.length);
    // 全部 kindle:pos 链接（fid off label）
    const links = [];
    const re = /<a\s+[^>]*href\s*=\s*["']kindle:pos:fid:([^"':]+):off:([0-9A-Za-z]+)["']\s*[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(html))) {
      links.push({ fid: m[1], off: m[2], label: m[3].replace(/<[^>]+>/g, '').trim(), pos: m.index });
    }
    console.log('links:', links.length);
    const fids = links.map((l) => b36(l.fid));
    console.log('fid b36: min', Math.min(...fids), 'max', Math.max(...fids), 'unique', new Set(fids).size);
    // 假设1：fid=base36 → html 块序号；off=base36 → 块内偏移
    let hit = 0, miss = 0;
    const samples = [];
    for (const l of links.slice(0, 400)) {
      const bi = b36(l.fid);
      const oi = b36(l.off);
      if (bi >= 1 && bi <= starts.length) {
        // 块内偏移 vs 全流偏移都试
        const abs1 = starts[bi - 1] + oi;
        const abs2 = starts[bi] !== undefined ? starts[bi] + oi : -1; // 0-based?
        const seg1 = html.slice(abs1, abs1 + 60).replace(/<[^>]+>/g, '').trim();
        const near = html.slice(starts[bi - 1], starts[bi - 1] + 400);
        const labelInBlock = l.label && near.includes(l.label.slice(0, Math.min(10, l.label.length)));
        if (labelInBlock) hit++; else miss++;
        if (samples.length < 8 && l.label) samples.push({ fid: l.fid, bi, off: l.off, oi, label: l.label.slice(0, 24), seg1: seg1.slice(0, 24), labelInBlock });
      } else { miss++; if (samples.length < 8) samples.push({ fid: l.fid, bi, note: 'fid 超块数' }); }
    }
    console.log('label-in-block hit:', hit, 'miss:', miss);
    console.log('samples:', JSON.stringify(samples, null, 1));
    // 假设2：off 是全流绝对偏移？抽验几个 off>0 的
    const nonzero = links.filter((l) => b36(l.off) > 0).slice(0, 6);
    for (const l of nonzero) {
      const oi = b36(l.off);
      const seg = html.slice(oi, oi + 80).replace(/<[^>]+>/g, ' ').trim();
      console.log(`abs-off test fid=${l.fid} off=${l.off}(${oi}) label="${l.label.slice(0, 20)}" seg="${seg.slice(0, 40)}"`);
    }
  }
})().catch(e => { console.error(e); process.exit(1); });
