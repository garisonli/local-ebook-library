// 目录扫描与文件夹树
const fs = require('fs');
const path = require('path');

const EXTS = new Set(['.epub', '.pdf', '.mobi', '.txt', '.azw', '.azw3']);
const SKIP_DIRS = new Set(['.git', 'node_modules', '.agnes', '$recycle.bin', 'system volume information', '.trash']);

function walk(root) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name.toLowerCase())) continue;
        stack.push(full);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (!EXTS.has(ext)) continue;
        let st;
        try { st = fs.statSync(full); } catch (err) { continue; }
        files.push({
          path: full,
          dir: path.dirname(full),
          filename: e.name,
          ext: ext.slice(1),
          file_size: st.size,
          mtime: Math.floor(st.mtimeMs)
        });
      }
    }
  }
  return files;
}

// 由书目目录列表构建文件夹树（相对 root，含子目录书籍数）
function makeTree(dirs, root, countFn) {
  const rootN = path.resolve(root);
  const nodes = new Map(); // rel -> node
  const get = (rel) => {
    if (nodes.has(rel)) return nodes.get(rel);
    const parts = rel ? rel.split('/') : [];
    const node = {
      name: rel ? parts[parts.length - 1] : '根目录',
      rel,
      children: new Map(),
      count: 0,
      abs: rel ? path.join(rootN, ...rel.split('/')) : rootN,
    };
    nodes.set(rel, node);
    if (rel) {
      const parent = get(parts.slice(0, -1).join('/'));
      parent.children.set(node.name, node);
    }
    return node;
  };
  get('');
  const rels = new Set();
  for (const d of dirs) {
    const rel = path.relative(rootN, d);
    if (!rel || rel.startsWith('..')) continue;
    const r = rel.split('\\').join('/');
    // 补齐各级父目录
    const parts = r.split('/');
    for (let i = 1; i <= parts.length; i++) rels.add(parts.slice(0, i).join('/'));
  }
  for (const r of rels) get(r);
  const rootNode = get('');
  const sortRec = (n) => {
    const arr = [...n.children.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    n.childList = arr;
    n.count = countFn(n.abs);
    arr.forEach(sortRec);
  };
  sortRec(rootNode);
  return rootNode;
}

module.exports = { walk, makeTree, EXTS };
