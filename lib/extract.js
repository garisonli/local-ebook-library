// 按格式分发元数据/封面抽取
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const epubExtract = require('./epub-extract');
const pdfMeta = require('./pdf-meta');
const mobi = require('./mobi');

function hashOf(s) {
  return crypto.createHash('md5').update(s).digest('hex').slice(0, 24);
}

function baseName(filePath) {
  const b = path.basename(filePath);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(0, i) : b;
}

// 从文件名提取书名：去掉扩展名、(Z-Library)、(UNKNOW)、(作者) 等噪音
function titleFromFilename(filePath) {
  let s = baseName(filePath);
  s = s.replace(/\s*\((z-?library|unknown|unKnown|扫描版|epub|pdf|mobi|azw3?|txt)\)\s*/gi, ' ');
  s = s.replace(/\s*\([^)]*\)\s*$/, ' ');   // 尾部残留的 (作者)
  s = s.replace(/\s{2,}/g, ' ').trim();
  return s || baseName(filePath);
}

// 判断元数据里的书名是否是无意义的哈希/占位
function badTitle(t) {
  if (!t) return true;
  const s = String(t).trim();
  if (/^[0-9a-f]{16,}$/i.test(s)) return true;             // md5/sha 哈希
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s)) return true;   // uuid
  if (/^<([0-9a-f]{2})+/i.test(s)) return true;           // 二进制转义垃圾（PDF 元数据泄露）
  if (/^(unknown|untitled|no title)$/i.test(s)) return true;
  if (/^downloaded from/i.test(s)) return true;
  if (/^microsoft word/i.test(s)) return true;
  if (/^[０-９]{1,6}$/.test(s)) return true;                // 全角数字（如「１１」，OCR/工具残留）
  if (/^[0-9]{1,3}$/.test(s)) return true;                 // 极短纯数字（如「11」；1984 等不受影响）
  if (s.length < 2) return true;
  return false;
}

// 归一化标题用于比较：去书名号/括号/空白/标点，转小写
function normTitle(s) {
  return String(s || '')
    .replace(/[\s《》「」『』〈〉\[\]（）()【】、，,．.·:：;；\-—_~〜"“”'‘’]+/g, '')
    .toLowerCase();
}

// PDF 专属取舍：扫描类 PDF 的内嵌元数据常是从别的文件拷来的错误标题
// （如《武侯八阵兵法辑略》内嵌为「战 略」）。两条标题完全不沾边、
// 且内嵌标题短、两边都是像样的中文书名时，信文件名；其余保持内嵌。
function pickPdfTitle(embedded, filePath) {
  const fn = titleFromFilename(filePath);
  if (badTitle(embedded)) return fn;
  if (badTitle(fn)) return String(embedded).trim();
  const e = normTitle(embedded), f = normTitle(fn);
  if (!e || !f) return String(embedded).trim();
  if (e === f || e.includes(f) || f.includes(e)) return String(embedded).trim();
  const cjk = /[一-鿿]/;
  // 内嵌标题是文件名的开头（文件名后面跟了作者/出版社等噪音）→ 保留内嵌
  const head = e.slice(0, Math.min(e.length, 4));
  if (head.length >= 2 && f.startsWith(head)) return String(embedded).trim();
  if (cjk.test(e) && cjk.test(f) && e.length <= 12) return fn;
  return String(embedded).trim();
}

function badAuthor(a) {
  if (!a) return true;
  const s = String(a).trim();
  if (/^(unknown|unKnown|n\/a|none|null|anonymous)$/i.test(s)) return true;
  if (/^[0-9a-f]{16,}$/i.test(s)) return true;
  return false;
}

// 统一清洗：垃圾书名回退到文件名，垃圾作者清空
function tidy(meta, filePath) {
  const out = { ...meta };
  if (badTitle(out.title)) out.title = titleFromFilename(filePath);
  if (badAuthor(out.author)) out.author = '';
  return out;
}

/**
 * 抽取一本书的元数据与封面，返回可写入数据库的字段。
 * 失败时返回占位元数据（文件名做书名），不抛异常。
 */
async function extractBook(filePath, coversDir) {
  const ext = path.extname(filePath).toLowerCase();
  const hash = hashOf(filePath);
  const fallback = {
    title: baseName(filePath),
    author: '',
    description: '',
    cover_path: '',
    cover_state: 0,
    extract_error: '',
  };
  try {
    if (ext === '.epub') {
      const r = await epubExtract.extract(filePath, coversDir, hash);
      return tidy({
        title: r.title || fallback.title,
        author: r.author || '',
        description: r.description || '',
        cover_path: r.cover_path || '',
        cover_state: r.cover_state || 0,
        extract_error: '',
      }, filePath);
    }
    if (ext === '.pdf') {
      const r = await pdfMeta.extract(filePath);
      const out = tidy({
        title: r.title || fallback.title,
        author: r.author || '',
        description: r.description || '',
        cover_path: '',
        cover_state: 0, // 首页快照队列处理
        extract_error: '',
      }, filePath);
      out.title = pickPdfTitle(r.title, filePath); // 内嵌标题与文件名取舍
      return out;
    }
    if (ext === '.mobi' || ext === '.azw' || ext === '.azw3') {
      try {
        const r = mobi.parseMeta(filePath);
        let coverPath = '';
        let coverState = 0;
        if (r.cover && r.cover.data && r.cover.data.length > 100) {
          coverPath = path.join(coversDir, hash + r.cover.ext);
          fs.writeFileSync(coverPath, r.cover.data);
          coverState = 1;
        }
        return tidy({
          title: r.title || fallback.title,
          author: r.author || '',
          description: r.description || '',
          cover_path: coverPath,
          cover_state: coverState,
          extract_error: '',
        }, filePath);
      } catch (e) {
        if (e.meta) {
          // DRM：元数据可读，正文不可
          return tidy({
            title: e.meta.title || fallback.title,
            author: e.meta.author || '',
            description: e.meta.description || '',
            cover_path: '',
            cover_state: 0,
            extract_error: 'DRM',
          }, filePath);
        }
        if (e.code === 'NOT_MOBI') {
          // 有些 .azw 其实是 KF8 包或别的变体，退回文件名
          return { ...fallback, extract_error: 'NOT_MOBI' };
        }
        throw e;
      }
    }
    // TXT / 其它
    return { ...fallback };
  } catch (e) {
    return { ...fallback, extract_error: String(e && e.message || e).slice(0, 120) };
  }
}

module.exports = { extractBook, hashOf, pickPdfTitle, badTitle, titleFromFilename };
