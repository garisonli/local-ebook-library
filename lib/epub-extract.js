// 从 OPF 里判断是否是 Z-Library 用哈希书名生成的假封面：书名是 32 位十六进制串
function isFakeCoverTitle(t) {
  return /^[0-9a-f]{16,}$/i.test(String(t || '').trim());
}
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, ent) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    const map = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    return map[ent.toLowerCase()] !== undefined ? map[ent.toLowerCase()] : m;
  });
}

function cleanText(s) {
  if (!s) return '';
  return decodeEntities(
    s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
  ).trim();
}

function tagContent(xml, tag) {
  const re = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>', 'i');
  const m = xml.match(re);
  return m ? m[1] : '';
}

function allTagContents(xml, tag) {
  const re = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>', 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

async function extract(filePath, coversDir, hash) {
  const buf = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(buf);

  // container.xml → OPF 路径
  const containerFile = zip.file('META-INF/container.xml');
  let opfPath = '';
  if (containerFile) {
    const containerXml = await containerFile.async('string');
    const m = containerXml.match(/full-path\s*=\s*["']([^"']+)["']/i);
    if (m) opfPath = decodeURIComponent(m[1]);
  }
  if (!opfPath) {
    const cand = Object.keys(zip.files).find((f) => f.toLowerCase().endsWith('.opf'));
    if (cand) opfPath = cand;
  }
  if (!opfPath || !zip.file(opfPath)) throw new Error('EPUB: 找不到 OPF 文件');

  const opfXml = await zip.file(opfPath).async('string');
  const opfDir = path.posix.dirname(opfPath);

  // 元数据
  const titles = allTagContents(opfXml, 'dc:title');
  const creators = allTagContents(opfXml, 'dc:creator');
  let title = cleanText(titles[0]);
  const author = creators.map(cleanText).filter(Boolean).join('、');

  let description = cleanText(tagContent(opfXml, 'dc:description'));
  if (!description) {
    const mm = opfXml.match(/<meta[^>]+name\s*=\s*["']description["'][^>]+content\s*=\s*["']([^"']*)["']/i);
    if (mm) description = cleanText(mm[1]);
  }

  // manifest（id → {href, type, props}）
  const manifest = {};
  const itemRe = /<item\b[^>]*>/gi;
  let im;
  while ((im = itemRe.exec(opfXml))) {
    const tag = im[0];
    const id = (tag.match(/\bid\s*=\s*["']([^"']+)["']/i) || [])[1];
    const href = (tag.match(/\bhref\s*=\s*["']([^"']+)["']/i) || [])[1];
    const type = (tag.match(/\bmedia-type\s*=\s*["']([^"']+)["']/i) || [])[1];
    const props = (tag.match(/\bproperties\s*=\s*["']([^"']+)["']/i) || [])[1] || '';
    if (id && href) manifest[id] = { href, type, props };
  }

  // 封面候选顺序：meta[name=cover] → properties=cover-image → 文件名含 cover 的图片 → 第一张图片
  const resolveEntry = (href) => {
    if (!href) return null;
    try {
      const norm = path.posix.normalize(path.posix.join(opfDir, decodeURIComponent(href.split('#')[0])));
      return zip.file(norm) || zip.file(decodeURIComponent(norm));
    } catch (e) { return null; }
  };
  const candidates = [];
  const metaCover = opfXml.match(/<meta\b[^>]+name\s*=\s*["']cover["'][^>]+content\s*=\s*["']([^"']+)["']/i)
    || opfXml.match(/<meta\b[^>]+content\s*=\s*["']([^"']+)["'][^>]+name\s*=\s*["']cover["']/i);
  if (metaCover && manifest[metaCover[1]]) candidates.push(manifest[metaCover[1]].href);
  const id0 = Object.keys(manifest).find((k) => /\bcover-image\b/.test(manifest[k].props));
  if (id0) candidates.push(manifest[id0].href);
  for (const k of Object.keys(manifest)) {
    if (/^image\//.test(manifest[k].type || '') && /cover/i.test(manifest[k].href)) candidates.push(manifest[k].href);
  }
  for (const k of Object.keys(manifest)) {
    if (/^image\//.test(manifest[k].type || '')) candidates.push(manifest[k].href);
  }

  let coverPath = '';
  let coverState = 0;
  for (const href of candidates) {
    const entry = resolveEntry(href);
    if (!entry) continue; // 该候选文件不存在，试下一个
    try {
      const data = await entry.async('nodebuffer');
      if (!data || data.length < 200) continue;
      const mt = (manifest[Object.keys(manifest).find((k) => manifest[k].href === href)] || {}).type || '';
      let ext = '.jpg';
      if (/png$/.test(mt)) ext = '.png';
      else if (/gif$/.test(mt)) ext = '.gif';
      else if (/svg/.test(mt)) ext = '.svg';
      else if (data[0] === 0x89 && data[1] === 0x50) ext = '.png';
      coverPath = path.join(coversDir, hash + ext);
      // Z-Library 用哈希书名生成的假封面（图里印着 32 位十六进制串），丢弃改用首页快照
      if (isFakeCoverTitle(title)) { coverPath = ''; coverState = -1; break; }
      fs.writeFileSync(coverPath, data);
      coverState = 1;
      break;
    } catch (e) { /* 该候选失败，试下一个 */ }
  }

  return { title, author, description, cover_path: coverPath, cover_state: coverState };
}

module.exports = { extract };
