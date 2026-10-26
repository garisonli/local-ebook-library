// MOBI / AZW / AZW3 尽力解析：元数据 + 封面 + HTML 正文（含 PalmDoc 解压）
const fs = require('fs');

function u16(b, o) { return b.readUInt16BE(o); }
function u32(b, o) { return b.readUInt32BE(o); }

function mobiError(code, msg) {
  const e = new Error(msg || code);
  e.code = code;
  return e;
}

function decodeBuf(buf, encoding) {
  if (!buf) return '';
  let s;
  if (encoding === 65001) s = buf.toString('utf8');
  else s = buf.toString('latin1'); // cp1252 近似
  return s.replace(/\0[\s\S]*$/, '').replace(/\0/g, '').trim();
}

function stripHtml(s) {
  if (!s) return '';
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function detectImage(buf) {
  if (!buf || buf.length < 16) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: '.jpg' };
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { mime: 'image/png', ext: '.png' };
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return { mime: 'image/gif', ext: '.gif' };
  return null;
}

// PalmDoc LZ77 解压
// 回溯引用为 14 位大端项：高 11 位 = 距离（不加 1），低 3 位 = 长度（+3）。
// 每条记录解压输出达到 maxOut（maxRecordSize=4096）即停止：压缩流结束后
// 记录尾部还残留 4~7 字节非文本字节，继续解会产出乱码（'<ht<ht' 之类回溯碎片）。
function palmdocDecompress(input, maxOut) {
  const out = [];
  const n = input.length;
  const cap = maxOut > 0 ? maxOut : Infinity;
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
      let start = out.length - dist;
      if (start < 0) start = 0;
      for (let k = 0; k < len && out.length < cap; k++) {
        const b2 = start + k < out.length ? out[start + k] : 0x20;
        out.push(b2);
      }
    } else {
      if (out.length < cap) out.push(0x20);
      if (out.length < cap) out.push(c ^ 0x80);
    }
  }
  return Buffer.from(out);
}

function parseHeader(records) {
  // 找含 MOBI 魔数的头记录（单文件通常 r0；双头 KF8 文件选版本号 >=8 的）
  const cands = [];
  for (let i = 0; i < records.length && i < 64; i++) {
    const r = records[i];
    if (r.length > 100 && r.toString('latin1', 16, 20) === 'MOBI') {
      cands.push({ index: i, version: r.length > 40 ? u32(r, 36) : 0 });
    }
  }
  if (!cands.length) throw mobiError('NOT_MOBI', '不是 MOBI 格式');
  let pick = cands.find((c) => c.version >= 8) || cands[0];

  const r0 = records[pick.index];
  const compression = u16(r0, 0);
  const textLength = u32(r0, 4);
  const numText = u16(r0, 8);
  const maxRecordSize = u16(r0, 10) || 4096;
  const encryption = u16(r0, 14);
  const headerLength = u32(r0, 20);
  const encoding = u32(r0, 28);

  // 全名（书名）
  let fullName = '';
  if (r0.length >= 88) {
    const nameOff = u32(r0, 80);
    const nameLen = u32(r0, 84);
    if (nameLen > 0 && nameLen < 1024 && nameOff + nameLen <= r0.length) {
      fullName = decodeBuf(r0.subarray(nameOff, nameOff + nameLen), encoding);
    }
    if (!fullName && pick.index === 0) {
      const first = records[0];
      if (nameLen > 0 && nameLen < 1024 && nameOff + nameLen <= first.length) {
        fullName = decodeBuf(first.subarray(nameOff, nameOff + nameLen), encoding);
      }
    }
  }

  // EXTH（位于 MOBI 头之后）
  const exth = new Map();
  let exthPos = 16 + headerLength;
  const findExth = (buf) => {
    const limit = Math.min(buf.length - 4, 8192);
    for (let i = 0; i < limit; i++) {
      if (buf.toString('latin1', i, i + 4) === 'EXTH') return i;
    }
    return -1;
  };
  if (!(exthPos + 8 <= r0.length && r0.toString('latin1', exthPos, exthPos + 4) === 'EXTH')) {
    const alt = findExth(r0);
    exthPos = alt;
  }
  if (exthPos >= 0 && exthPos + 12 <= r0.length && r0.toString('latin1', exthPos, exthPos + 4) === 'EXTH') {
    let p = exthPos + 12; // magic(4) + len(4) + count(4)
    const total = exthPos + u32(r0, exthPos + 4);
    const count = u32(r0, exthPos + 8);
    for (let i = 0; i < count && p + 8 <= Math.min(total, r0.length); i++) {
      const type = u32(r0, p);
      const len = u32(r0, p + 4);
      if (len < 8 || p + len > r0.length) break;
      const data = r0.subarray(p + 8, p + len);
      if (!exth.has(type)) exth.set(type, []);
      exth.get(type).push(data);
      p += len;
    }
  }

  const first = (type) => {
    const arr = exth.get(type);
    return arr && arr.length ? arr[0] : null;
  };

  let title = '';
  const t503 = first(503);
  if (t503) title = decodeBuf(t503, encoding);
  if (!title) title = fullName;
  if (!title && pick.index > 0) {
    const altOff = u32(r0, 80), altLen = u32(r0, 84);
    const rec0 = records[0];
    if (altLen > 0 && altOff + altLen <= rec0.length) title = decodeBuf(rec0.subarray(altOff, altOff + altLen), encoding);
  }

  const authors = (exth.get(100) || []).map((b) => decodeBuf(b, encoding)).filter(Boolean);
  const author = authors.join('、');
  const t103 = first(103);
  const description = t103 ? stripHtml(decodeBuf(t103, encoding)) : '';

  const coverOff = first(201) && first(201).length >= 4 ? first(201).readUInt32BE(0) : null;
  const thumbOff = first(202) && first(202).length >= 4 ? first(202).readUInt32BE(0) : null;
  const hasFakeCover = first(203) !== null;

  return {
    headerIndex: pick.index,
    compression, textLength, numText, maxRecordSize, encoding, encryption,
    title, author, description, coverOff, thumbOff, hasFakeCover,
  };
}

function collectImages(records, headerIndex, textCount) {
  const images = []; // {index, buf, mime, ext}
  const scanFrom = headerIndex + 1 + textCount;
  for (let i = scanFrom; i < records.length; i++) {
    const d = detectImage(records[i]);
    if (d) images.push({ index: i, buf: records[i], mime: d.mime, ext: d.ext });
  }
  if (!images.length) {
    for (let i = headerIndex + 1; i < records.length; i++) {
      if (i < scanFrom) continue;
      const d = detectImage(records[i]);
      if (d) images.push({ index: i, buf: records[i], mime: d.mime, ext: d.ext });
    }
  }
  return images;
}

// HUFF/CDIC（压缩码 17480 = 0x4448）尾部冗余区长度。
// extra_record_flags（record0 偏移 240 的 u32 低 16 位）：bit15..1 每个置位表示
// 记录尾部有一个 TBS 区，其总大小是区末尾的 varint（首字节带高位标记）；bit0
// 表示 multibyte overlap 字节，必须最后剥。这些字节在压缩流之外，先剥再解码。
// 算法对齐 kindling huffcdic.rs（与 KindleUnpack/libmobi 一致）。
function trailingDataLen(record, flags) {
  let end = record.length;
  for (let bit = 15; bit >= 1; bit--) {
    if (!(flags & (1 << bit)) || end === 0) continue;
    const from = Math.max(0, end - 4);
    let size = 0;
    for (let i = from; i < end; i++) {
      const b = record[i];
      if (b & 0x80) size = 0;
      size = ((size << 7) | (b & 0x7F)) >>> 0;
    }
    end -= Math.min(size, end);
  }
  if ((flags & 1) && end > 0) {
    end -= Math.min((record[end - 1] & 3) + 1, end);
  }
  return record.length - end;
}

// HUFF/CDIC 解压。算法逐行对齐 calibre ebooks/mobi/huffcdic.py（Kovid Goyal），
// 并与 kindling huffcdic.rs、KindleUnpack mobi_uncompress.py 交叉验证。
// HUFF 记录（record0@112 索引、@116 数量，相对本节 record0）：off1 处 256 项
// 主表（按位窗高 8 位索引），off2 处 32 对 (mincode,maxcode) 按码长 1..32。
// 字典索引 = raw_max - (code >> (32-codelen))；码长不足 8 时沿 mincode 码表爬升。
// CDIC 记录携带短语字典，0x8000 标志清除的短语本身还是压缩位流，首次使用时
// 递归展开并写回（记忆化）。
function huffCdicDecompress(records, hdr) {
  const r0 = records[hdr.headerIndex];
  const huffRel = r0.length >= 120 ? u32(r0, 112) : 0;
  const huffCnt = r0.length >= 120 ? u32(r0, 116) : 0;
  if (!huffRel || huffRel === 0xFFFFFFFF || huffCnt < 2) {
    throw mobiError('HUFF', '缺少 HUFF/CDIC 记录');
  }
  const base = hdr.headerIndex + huffRel;
  if (base + huffCnt > records.length) throw mobiError('HUFF', 'HUFF/CDIC 记录号越界');
  const huff = records[base];
  if (huff.length < 24 || huff.toString('latin1', 0, 4) !== 'HUFF') {
    throw mobiError('HUFF', 'HUFF 记录魔数错误');
  }
  const off1 = u32(huff, 8), off2 = u32(huff, 12);
  if (off1 + 256 * 4 > huff.length || off2 + 32 * 8 > huff.length) {
    throw mobiError('HUFF', 'HUFF 码表越界');
  }
  const dict1 = new Array(256);
  for (let i = 0; i < 256; i++) {
    const v = u32(huff, off1 + i * 4);
    const codelen = v & 0x1F;
    const term = (v & 0x80) !== 0;
    if (codelen === 0) throw mobiError('HUFF', 'HUFF 表项 ' + i + ' 码长为 0');
    if (codelen <= 8 && !term) throw mobiError('HUFF', 'HUFF 表项 ' + i + ' 短码未标记终端');
    dict1[i] = { codelen, term, rawMax: v >>> 8 };
  }
  // 未移位存储；比较时用 code>>(32-codelen) 等价转换（code < min<<k ⟺ code>>k < min）
  const mincode = new Array(33), maxcode = new Array(33);
  mincode[0] = 0; maxcode[0] = 0;
  for (let len = 1; len <= 32; len++) {
    mincode[len] = u32(huff, off2 + (len - 1) * 8);
    maxcode[len] = u32(huff, off2 + (len - 1) * 8 + 4);
  }

  const dict = [];
  for (let ci = 1; ci < huffCnt; ci++) {
    const cdic = records[base + ci];
    if (!cdic || cdic.length < 16 || cdic.toString('latin1', 0, 4) !== 'CDIC') {
      throw mobiError('HUFF', 'CDIC 记录魔数错误');
    }
    const phrases = u32(cdic, 8);
    const bits = u32(cdic, 12);
    if (bits > 16) throw mobiError('HUFF', 'CDIC 位宽异常 ' + bits);
    const n = Math.min(1 << bits, phrases - dict.length);
    if (16 + n * 2 > cdic.length) throw mobiError('HUFF', 'CDIC 偏移表越界');
    for (let i = 0; i < n; i++) {
      const off = u16(cdic, 16 + i * 2);
      const blenPos = 16 + off;
      if (blenPos + 2 > cdic.length) throw mobiError('HUFF', 'CDIC 条目越界');
      const blen = u16(cdic, blenPos);
      const len = blen & 0x7FFF;
      const start = blenPos + 2;
      if (start + len > cdic.length) throw mobiError('HUFF', 'CDIC 数据越界');
      dict.push({ data: cdic.subarray(start, start + len), plain: (blen & 0x8000) !== 0 });
    }
  }
  if (!dict.length) throw mobiError('HUFF', 'CDIC 字典为空');

  // 位窗：hi/lo 拼 64 位，n 为高 32 位中未消费位数（1..32），MSB 优先。
  // 尾部越界读必须补零（与 calibre 的 data+8 零字节一致），不能直接置 0，
  // 否则记录尾部的低位字节丢失，解码错位产生乱码。
  function decode(data) {
    const chunks = [];
    let bitsleft = data.length * 8;
    const padded = Buffer.concat([data, Buffer.alloc(8)]);
    let pos = 0;
    let hi = u32(padded, 0);
    let lo = u32(padded, 4);
    let n = 32;
    for (;;) {
      if (n <= 0) {
        pos += 4;
        hi = u32(padded, pos);
        lo = u32(padded, pos + 4);
        n += 32;
      }
      const code = n === 32 ? hi : (((hi << (32 - n)) | (lo >>> n)) >>> 0);
      const e = dict1[code >>> 24];
      let codelen = e.codelen;
      let rawMax = e.rawMax;
      if (!e.term) {
        while (codelen < 32 && (code >>> (32 - codelen)) < mincode[codelen]) codelen++;
        if (codelen >= 32 && (code >>> 0) < mincode[32]) throw mobiError('HUFF', '码长爬升越界');
        rawMax = maxcode[codelen];
      }
      n -= codelen;
      bitsleft -= codelen;
      if (bitsleft < 0) break;
      const r = rawMax - (code >>> (32 - codelen));
      const ent = dict[r];
      if (!ent) throw mobiError('HUFF', '短语索引越界 ' + r);
      if (ent.plain) {
        chunks.push(ent.data);
      } else {
        dict[r] = null; // 环保护
        const expanded = decode(ent.data);
        dict[r] = { data: expanded, plain: true };
        chunks.push(expanded);
      }
    }
    return Buffer.concat(chunks);
  }

  const flags = r0.length >= 244 ? (u32(r0, 240) & 0xFFFF) : 0;
  let remain = hdr.textLength > 0 ? hdr.textLength : Infinity;
  const outs = [];
  for (let i = 0; i < hdr.numText; i++) {
    const recIdx = hdr.headerIndex + 1 + i;
    if (recIdx >= records.length || remain <= 0) break;
    let rec = records[recIdx];
    if (flags) {
      const trim = trailingDataLen(rec, flags);
      if (trim > 0 && trim < rec.length) rec = rec.subarray(0, rec.length - trim);
    }
    const out = decode(rec);
    outs.push(out);
    remain -= out.length;
  }
  if (!outs.length) throw mobiError('TEXT_EMPTY', '没有正文记录');
  let raw = Buffer.concat(outs);
  if (hdr.textLength > 0 && raw.length > hdr.textLength) raw = raw.subarray(0, hdr.textLength);
  return raw;
}

function decompressText(records, hdr) {
  const slice = [];
  for (let i = hdr.headerIndex + 1; i < records.length && slice.length < hdr.numText; i++) slice.push(records[i]);
  if (!slice.length) throw mobiError('TEXT_EMPTY', '没有正文记录');
  let raw;
  if (hdr.compression === 1) {
    raw = Buffer.concat(slice);
  } else if (hdr.compression === 2) {
    const maxOut = hdr.maxRecordSize > 0 && hdr.maxRecordSize <= 65536 ? hdr.maxRecordSize : 4096;
    let remain = hdr.textLength > 0 ? hdr.textLength : Infinity;
    const outs = [];
    for (const p of slice) {
      if (remain <= 0) break;
      const o = palmdocDecompress(p, Math.min(maxOut, remain));
      outs.push(o);
      remain -= o.length;
    }
    raw = Buffer.concat(outs);
  } else if (hdr.compression === 17480 || hdr.compression === 0x4448) {
    raw = huffCdicDecompress(records, hdr);
  } else throw mobiError('COMPRESS', '不支持的压缩方式 ' + hdr.compression);

  if (hdr.textLength > 0 && hdr.textLength < raw.length) raw = raw.subarray(0, hdr.textLength);
  let html;
  if (hdr.encoding === 65001) html = raw.toString('utf8');
  else html = raw.toString('latin1');
  html = html.replace(/\0/g, '');
  return html;
}

function buildToc(html) {
  const toc = [];
  let n = 0;
  html = html.replace(/<h([1-3])([^>]*)>([\s\S]*?)<\/h\1>/gi, (m, lvl, attrs, inner) => {
    const label = stripHtml(inner).slice(0, 80) || '未命名章节';
    let id = (attrs.match(/\bid\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (!id) {
      id = 'gen-toc-' + n;
      attrs += ' id="' + id + '"';
    }
    n++;
    toc.push({ label, id });
    return '<h' + lvl + attrs + '>' + inner + '</h' + lvl + '>';
  });
  return { html, toc };
}

function embedImages(html, images, coverIndex, opts) {
  // 优先顺序池：排除封面（单独作为 cover_data 返回）
  const pool = images.filter((im) => im.index !== coverIndex).slice();
  // 落盘模式：图片总量过大时 base64 内嵌会超出 V8 字符串上限（如 16 册漫画
  // 套装），改为写入 opts.imgDir 并用 opts.imgUrl 生成引用（elocal:// 协议）。
  let diskMode = false;
  if (opts && opts.imgDir && opts.imgUrl && pool.length) {
    let total = 0;
    for (const im of pool) total += im.buf.length;
    if (total > 24 * 1024 * 1024) { // 超过 ~24MB 原始图片即落盘
      try {
        require('fs').mkdirSync(opts.imgDir, { recursive: true });
        diskMode = true;
      } catch (e) { diskMode = false; }
    }
  }
  let diskIdx = 0;
  const nextUri = (im) => {
    if (!diskMode) return 'data:' + im.mime + ';base64,' + im.buf.toString('base64');
    try {
      const fs = require('fs');
      const path = require('path');
      const name = 'img-' + String(diskIdx++).padStart(4, '0') + im.ext;
      const fp = path.join(opts.imgDir, name);
      fs.writeFileSync(fp, im.buf);
      return opts.imgUrl(fp);
    } catch (e) {
      return 'data:' + im.mime + ';base64,' + im.buf.toString('base64');
    }
  };
  let i = 0;
  const html2 = html.replace(/<img\b[^>]*>/gi, (tag) => {
    const uri = i < pool.length ? nextUri(pool[i]) : null;
    i++;
    if (!uri) return tag.replace(/\bsrc\s*=\s*("[^"]*"|'[^']*')/i, 'src=""');
    if (/\bsrc\s*=\s*("[^"]*"|'[^']*')/i.test(tag)) {
      return tag.replace(/\bsrc\s*=\s*("[^"]*"|'[^']*')/i, 'src="' + uri + '"');
    }
    return tag.replace(/^<img/i, '<img src="' + uri + '"');
  });
  return html2;
}

function ensureDoc(html) {
  if (/<html[\s>]/i.test(html)) {
    if (!/<meta[^>]+charset/i.test(html)) {
      html = html.replace(/<head[^>]*>/i, (m) => m + '<meta charset="utf-8">');
    }
    return html;
  }
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
    'body{margin:0;padding:16px 20px;line-height:1.8;font-size:17px;color:#222;word-wrap:break-word;}' +
    'img{max-width:100%;height:auto;} a{color:#c0392b;} table{max-width:100%;}' +
    '</style></head><body>' + html + '</body></html>';
}

/** 只解析元数据 + 封面（扫描阶段调用，速度快） */
function parseMeta(filePath) {
  const buf = fs.readFileSync(filePath);
  const { records } = splitRecords(buf);
  const hdr = parseHeader(records);
  if (hdr.encryption !== 0 && hdr.encryption !== 2) {
    const e = mobiError('DRM', '该书含 DRM 加密');
    e.meta = { title: hdr.title, author: hdr.author, description: hdr.description };
    throw e;
  }
  const images = collectImages(records, hdr.headerIndex, hdr.numText);
  let cover = null;
  if (hdr.coverOff !== null && images[hdr.coverOff]) {
    const im = images[hdr.coverOff];
    cover = { mime: im.mime, ext: im.ext, data: im.buf };
  } else if (hdr.thumbOff !== null && images[hdr.thumbOff]) {
    const im = images[hdr.thumbOff];
    cover = { mime: im.mime, ext: im.ext, data: im.buf };
  } else if (hdr.hasFakeCover && images.length) {
    const im = images[0];
    cover = { mime: im.mime, ext: im.ext, data: im.buf };
  } else if (hdr.coverOff !== null && hdr.coverOff >= 0 && images.length) {
    // coverOff 偏差时兜底：仅当只有一张图
    if (images.length === 1) {
      const im = images[0];
      cover = { mime: im.mime, ext: im.ext, data: im.buf };
    }
  }
  return {
    title: hdr.title,
    author: hdr.author,
    description: hdr.description,
    cover,
  };
}

/** 生成内嵌阅读器用的 HTML（含正文、内嵌图片、目录锚点）。
 * opts.imgDir / opts.imgUrl：大书图片落盘模式（避免 base64 超出字符串上限）。 */
function parseHtml(filePath, opts) {
  const buf = fs.readFileSync(filePath);
  const { records } = splitRecords(buf);
  const hdr = parseHeader(records);
  if (hdr.encryption !== 0 && hdr.encryption !== 2) throw mobiError('DRM', '该书含 DRM 加密，无法解析');
  const rawHtml = decompressText(records, hdr);
  const images = collectImages(records, hdr.headerIndex, hdr.numText);
  const coverIdx = hdr.coverOff !== null && images[hdr.coverOff] ? images[hdr.coverOff].index : -1;
  let html = embedImages(rawHtml, images, coverIdx, opts);
  const withToc = buildToc(html);
  html = ensureDoc(withToc.html);
  return { html, toc: withToc.toc };
}

function splitRecords(buf) {
  if (buf.length < 78) throw mobiError('NOT_MOBI', '文件太小');
  const pdbType = buf.toString('latin1', 60, 64); // BOOK/TEXt/EXTH...
  const numRecords = u16(buf, 76);
  if (!numRecords || numRecords > 65535 || 78 + numRecords * 8 > buf.length) {
    throw mobiError('NOT_MOBI', '不是 MOBI 格式');
  }
  if (!/BOOK|TEXt|EXTH|MOBI|KPZT|REPL|TEXT/i.test(pdbType) &&
      buf.toString('latin1', 16, 20) !== 'MOBI') {
    // 类型串不匹配时再看魔数，宽松处理
    const r0off = buf.readUInt32BE(78);
    if (r0off >= buf.length) throw mobiError('NOT_MOBI', '不是 MOBI 格式');
  }
  const offsets = [];
  for (let i = 0; i < numRecords; i++) offsets.push(u32(buf, 78 + i * 8));
  for (let i = 1; i < offsets.length; i++) {
    if (offsets[i] < offsets[i - 1] || offsets[0] < 78 + numRecords * 8) {
      throw mobiError('NOT_MOBI', '记录表损坏');
    }
  }
  offsets.push(buf.length);
  const records = [];
  for (let i = 0; i < numRecords; i++) records.push(buf.subarray(offsets[i], offsets[i + 1]));
  if (!records.length || records[0].length < 100) throw mobiError('NOT_MOBI', '不是 MOBI 格式');
  return { records };
}

module.exports = { parseMeta, parseHtml };
