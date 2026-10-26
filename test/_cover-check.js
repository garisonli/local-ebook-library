const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const dir = 'E:\\伴读学习\\电子书\\通识常识\\哲学经典';
const f = fs.readdirSync(dir).find((x) => x.includes('莱瑟塔'));

(async () => {
  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(dir, f)));
  const entries = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
  console.log('ENTRIES:', entries);

  const containerXml = await zip.file('META-INF/container.xml').async('string');
  const opfPath = containerXml.match(/full-path\s*=\s*["']([^"']+)["']/i)[1];
  const opfXml = await zip.file(opfPath).async('string');
  const opfDir = path.posix.dirname(opfPath);
  console.log('opfPath:', opfPath, '| opfDir:', opfDir);

  const manifest = {};
  const itemRe = /<item\b[^>]*>/gi;
  let im;
  while ((im = itemRe.exec(opfXml))) {
    const t = im[0];
    const id = (t.match(/\bid\s*=\s*["']([^"']+)["']/i) || [])[1];
    const href = (t.match(/\bhref\s*=\s*["']([^"']+)["']/i) || [])[1];
    const type = (t.match(/\bmedia-type\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (id && href) manifest[id] = { href, type };
  }
  console.log('manifest:', manifest);

  const metaCover = opfXml.match(/<meta\b[^>]+name\s*=\s*["']cover["'][^>]+content\s*=\s*["']([^"']+)["']/i);
  console.log('metaCover content:', metaCover && metaCover[1], '| in manifest:', !!(metaCover && manifest[metaCover[1]]));

  const resolveEntry = (href) => {
    if (!href) return null;
    const norm = path.posix.normalize(path.posix.join(opfDir, decodeURIComponent(href.split('#')[0])));
    return zip.file(norm) || zip.file(decodeURIComponent(norm)) || null;
  };
  console.log('resolveEntry cover_image.jpg:', !!resolveEntry('cover_image.jpg'));
  const entry = resolveEntry('cover_image.jpg');
  if (entry) {
    const data = await entry.async('nodebuffer');
    console.log('cover data bytes:', data.length, '| first bytes:', data.slice(0, 4));
  }
})();
