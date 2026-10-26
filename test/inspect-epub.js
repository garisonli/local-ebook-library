const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const dir = 'E:\\伴读学习\\电子书\\通识常识\\哲学经典';
const f = fs.readdirSync(dir).find((x) => x.includes('莱瑟塔'));
console.log('FILE:', f);

(async () => {
  const z = await JSZip.loadAsync(fs.readFileSync(path.join(dir, f)));
  const names = Object.keys(z.files).filter((n) => !z.files[n].dir);
  console.log('ENTRIES:', names.join(' | '));
  const opfName = names.find((n) => n.endsWith('.opf'));
  const opf = await z.file(opfName).async('string');
  console.log('--- OPF (%d chars) ---', opf.length);
  console.log(opf.slice(0, 2600));
  const spine = opf.match(/<spine[\s\S]*?<\/spine>/);
  console.log('\nSPINE:', spine ? spine[0].replace(/\s+/g, ' ') : 'NONE');
})();
