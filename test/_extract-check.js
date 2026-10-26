const fs = require('fs');
const path = require('path');
const { extractBook } = require('../lib/extract.js');

const dir = 'E:\\伴读学习\\电子书\\通识常识\\哲学经典';
const f = fs.readdirSync(dir).find((x) => x.includes('莱瑟塔'));

extractBook(path.join(dir, f), path.join(__dirname, '.tmpcovers')).then((m) => {
  console.log('TITLE  :', m.title);
  console.log('AUTHOR :', m.author);
  console.log('COVER  :', m.cover_state, m.cover_path);
});
