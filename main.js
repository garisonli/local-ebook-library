// 电子书图书馆 · 主进程
const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, session } = require('electron');
const path = require('path');
const fs = require('fs');

const db = require('./lib/db');
const { walk, makeTree } = require('./lib/scanner');
const { extractBook, hashOf } = require('./lib/extract');
const mobi = require('./lib/mobi');

// ---------- 自定义协议：让渲染层能 fetch 本地电子书/封面（相对路径解析对 epub.js 友好） ----------
protocol.registerSchemesAsPrivileged([
  { scheme: 'elocal', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

function elocalUrl(p) {
  if (!p) return '';
  return 'elocal://f/' + String(p).replace(/\\/g, '/').replace(/^\//, '');
}

function elocalToPath(url) {
  const u = new URL(url);
  let p = decodeURIComponent(u.pathname.slice(1));
  if (!/^[A-Za-z]:[\\/]/.test(p)) p = '/' + p;
  return p;
}

// ---------- 设置 ----------
const defaults = { libraryName: '我的图书馆', rootDir: '', perPage: 24 };
let settings = { ...defaults };
let coversDir = '';
let cacheDir = '';

function settingsFile() { return path.join(app.getPath('userData'), 'settings.json'); }
function loadSettings() {
  try {
    const raw = fs.readFileSync(settingsFile(), 'utf8').replace(/^\uFEFF/, '');
    settings = { ...defaults, ...JSON.parse(raw) };
  } catch (e) { settings = { ...defaults }; }
  if (!Number.isFinite(settings.perPage) || settings.perPage < 1) settings.perPage = 24;
}
function persistSettings() {
  try { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch (e) { /* ignore */ }
}

function sendAll(ch, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.send(ch, payload); } catch (e) { /* ignore */ }
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 扫描 ----------
const scanState = { running: false };
async function doScan() {
  if (scanState.running) return { ok: false, error: '正在扫描中' };
  const root = settings.rootDir;
  if (!root) return { ok: false, error: '请先在设置中选择书籍文件夹' };
  if (!fs.existsSync(root)) return { ok: false, error: '文件夹不存在：' + root };
  scanState.running = true;
  try {
    sendAll('scan:status', { phase: 'walk', msg: '正在遍历文件夹…', done: 0, total: 0 });
    await sleep(30);
    const files = walk(root);
    const known = db.allPaths();
    const seen = new Set();
    const jobs = [];
    let added = 0, updated = 0;

    // 第一遍：新书立即以「文件名占位」入库，让目录树和第一页封面马上可用
    for (const f of files) {
      seen.add(f.path);
      const k = known[f.path];
      if (!k) {
        const id = db.insertBook({
          ...f,
          title: f.filename.replace(/\.[^.]+$/, ''),
          author: '', description: '', cover_path: null, cover_state: 0,
        });
        jobs.push({ f, kind: 'update', id });
        added++;
      } else if (k.mtime !== f.mtime || k.file_size !== f.file_size) {
        jobs.push({ f, kind: 'update', id: k.id });
        updated++;
      }
    }
    const removed = Object.keys(known).filter((p) => !seen.has(p));
    for (const p of removed) db.removeByPath(p);
    db.persist();

    // 通知渲染层：列表已可用（树 + 书名占位卡片），进入后台元数据解析
    sendAll('scan:status', {
      phase: 'listing',
      msg: `书目列表已就绪（${files.length} 本），正在后台解析元数据…`,
      done: 0, total: jobs.length, listed: files.length,
    });
    await sleep(150); // 给渲染层一次刷新窗口

    // 第二遍：逐本补元数据/内嵌封面，周期性推送进度并触发界面刷新
    // 规则：新抽取结果如果书名/作者是垃圾（哈希、Unknown 等），保留库里已有非垃圾值，不用垃圾覆盖
    const garbage = (v) => {
      const s = String(v == null ? '' : v).trim();
      if (!s) return true;
      if (/^[0-9a-f]{16,}$/i.test(s)) return true;
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s)) return true;
      if (/^[０-９]{1,6}$/.test(s)) return true;
      if (/^[0-9]{1,3}$/.test(s)) return true;
      return /^(unknown|untitled|no title|n\/a|none)$/i.test(s);
    };
    const totalWork = jobs.length;
    let done = 0;
    for (const j of jobs) {
      try {
        const meta = await extractBook(j.f.path, coversDir);
        let title = meta.title;
        let author = meta.author;
        if (garbage(title)) {
          const cur = db.getById(j.id);
          if (cur && !garbage(cur.title)) title = cur.title;
        }
        if (garbage(author)) {
          const cur = db.getById(j.id);
          if (cur && !garbage(cur.author)) author = cur.author;
        }
        db.updateExtract(j.id, { ...j.f, ...meta, title, author });
      } catch (e) {
        db.updateExtract(j.id, j.f); // 抽取失败也保留占位记录
      }
      done++;
      if (done % 10 === 0 || done === totalWork) {
        db.schedulePersist();
        sendAll('scan:status', {
          phase: 'meta', msg: `正在解析元数据与封面 ${done}/${totalWork}`,
          done, total: totalWork, refresh: true,
        });
      }
      if (done % 2 === 0) await sleep(0); // 让出事件循环，界面不卡
    }
    db.persist();

    const result = { ok: true, added, updated, removed: removed.length, total: files.length };
    console.log('[scan] done', JSON.stringify(result));
    sendAll('scan:done', result);
    runCoverQueue(); // 封面快照后台继续，不阻塞 UI
    return result;
  } finally {
    scanState.running = false;
  }
}

// ---------- 首页封面快照队列（隐藏窗口渲染 + capturePage） ----------
const snapState = { win: null, running: false, ready: false, loading: null };

function ensureSnapshotWindow() {
  if (snapState.win && !snapState.win.isDestroyed()) return snapState.win;
  snapState.ready = false;
  const win = new BrowserWindow({
    width: 480, height: 640, show: false, frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  win.setMenuBarVisibility(false);
  snapState.win = win;
  snapState.loading = new Promise((resolve) => {
    win.webContents.once('did-finish-load', () => { snapState.ready = true; resolve(); });
    win.webContents.once('did-fail-load', () => resolve());
  });
  win.on('closed', () => { snapState.win = null; snapState.ready = false; });
  win.loadFile(path.join(__dirname, 'src', 'snapshot.html'));
  return win;
}

function snapshotRender(payload, timeoutMs) {
  const win = snapState.win;
  if (!win || win.isDestroyed() || !snapState.ready) return Promise.resolve(null);
  return new Promise((resolve) => {
    let timer = null;
    const done = (val) => {
      clearTimeout(timer);
      win.webContents.removeListener('ipc-message', onMsg);
      resolve(val);
    };
    const onMsg = (e, channel, args) => {
      if (channel !== '__snapshot' || !args) return;
      if (args.ch === 'snapshot:ready') {
        win.webContents.capturePage().then((img) => {
          const png = img.toPNG();
          done(png && png.length > 200 ? png : null);
        }).catch(() => done(null));
      } else if (args.ch === 'snapshot:error') {
        console.warn('[snapshot] render error:', args.error || '');
        done(null);
      }
    };
    timer = setTimeout(() => { console.log('[snapshot] timeout waiting reply, type=', payload && payload.type); done(null); }, timeoutMs || 30000);
    win.webContents.on('ipc-message', onMsg);
    console.log('[snapshot] send render, type=', payload && payload.type);
    win.webContents.send('snapshot:render', payload);
  });
}

function restartSnapshotWindow() {
  try {
    if (snapState.win && !snapState.win.isDestroyed()) snapState.win.destroy();
  } catch (e) { /* ignore */ }
  snapState.win = null;
  snapState.ready = false;
  ensureSnapshotWindow();
  return snapState.loading;
}

async function runCoverQueue() {
  if (snapState.running) return;
  snapState.running = true;
  try {
    const all = db.listBooks({ page: 1, perPage: 500000 }).list;
    // 候选：未生成封面的 + 失败的 PDF（仅重试 PDF，其它格式失败不重试）+ 疑似空白页的 PDF 封面
    const cands = all.filter((b) => {
      if (b.cover_state === 0) return true;
      if (b.cover_state === -1) return true;
      const e = '.' + (b.ext || '').toLowerCase();
      if (e !== '.pdf') return false;
      if (b.cover_state === 2 && b.cover_path) {
        try { return fs.statSync(b.cover_path).size < 8000; } catch (e2) { return false; }
      }
      return false;
    });
    console.log('[cover] queue start, candidates =', cands.length);
    if (!cands.length) { sendAll('covers:done', { skipped: true }); return; }

    ensureSnapshotWindow();
    await snapState.loading;
    console.log('[cover] snapshot window ready');
    let ok = 0, fail = 0;
    for (let i = 0; i < cands.length; i++) {
      const b = cands[i];
      if (!snapState.win || snapState.win.isDestroyed()) { ensureSnapshotWindow(); await snapState.loading; }
      sendAll('scan:status', {
        phase: 'cover',
        msg: `正在生成封面（第一页快照） ${i + 1}/${cands.length}`,
        done: i + 1, total: cands.length,
        refresh: (i % 6 === 0), // 每 6 本通知界面刷新一次，封面陆续出现
      });

      let payload = null;
      const ext = '.' + (b.ext || '').toLowerCase();
      try {
        if (ext === '.pdf') payload = { type: 'pdf', url: elocalUrl(b.path) };
        else if (ext === '.epub') payload = { type: 'epub', url: elocalUrl(b.path) };
        else if (ext === '.txt') {
          const buf = fs.readFileSync(b.path);
          payload = { type: 'text', text: decodeText(buf).slice(0, 1500) };
        } else {
          const { html } = mobi.parseHtml(b.path);
          payload = { type: 'html', html: html.slice(0, 400000) };
        }
      } catch (e) {
        db.setCover(b.id, '', -1); fail++;
        continue;
      }

      // PDF 按文件大小放宽超时：大扫描版 PDF 首次解码慢
      let timeoutMs = 30000;
      if (ext === '.pdf') {
        const mb = (b.file_size || 0) / 1048576;
        timeoutMs = Math.min(120000, Math.max(30000, 20000 + mb * 8000));
      }
      const png = payload ? await snapshotRender(payload, timeoutMs) : null;
      if (png && png.length > 500) {
        const p = path.join(coversDir, hashOf(b.path) + '.png');
        try { fs.writeFileSync(p, png); db.setCover(b.id, p, 2); ok++; }
        catch (e) { db.setCover(b.id, '', -1); fail++; }
      } else {
        db.setCover(b.id, '', -1); fail++;
        // 失败后重建快照窗口，防止坏状态连累后面的书
        console.log('[cover] rebuild snapshot window after fail:', b.filename);
        await restartSnapshotWindow();
      }
      if (i % 5 === 4) db.schedulePersist();
    }
    db.persist();
    sendAll('covers:done', { ok, fail });
  } catch (e) {
    sendAll('covers:done', { error: String(e && e.message || e) });
  } finally {
    snapState.running = false;
  }
}

// ---------- 文本编码识别（TXT 阅读 / 快照） ----------
function decodeText(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    try { return new TextDecoder('utf-8').decode(buf.subarray(3)); } catch (e) { /* fall */ }
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    try { return new TextDecoder('utf-16le').decode(buf.subarray(2)); } catch (e) { /* fall */ }
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    try {
      const swap = Buffer.from(buf.subarray(2));
      swap.swap16();
      return new TextDecoder('utf-16le').decode(swap);
    } catch (e) { /* fall */ }
  }
  let utf8 = '';
  try { utf8 = new TextDecoder('utf-8').decode(buf); } catch (e) { utf8 = ''; }
  const bad = (utf8.match(/\uFFFD/g) || []).length;
  if (utf8 && bad * 200 < utf8.length) return utf8;
  try { return new TextDecoder('gbk').decode(buf); } catch (e) { return utf8; }
}

// ---------- 移动文件（资源管理器意义上的真实移动） ----------
function deleteBook(id) {
  const b = db.getById(id);
  if (!b) return { ok: false, error: '书籍不存在' };
  try {
    if (fs.existsSync(b.path)) fs.unlinkSync(b.path);
  } catch (e) {
    return { ok: false, error: '删除文件失败：' + String(e && e.message || e) };
  }
  // 清理封面缓存
  try {
    if (b.cover_path && fs.existsSync(b.cover_path)) fs.unlinkSync(b.cover_path);
    const coverPng = path.join(coversDir, hashOf(b.path) + '.png');
    if (fs.existsSync(coverPng)) fs.unlinkSync(coverPng);
    const coverJpg = path.join(coversDir, hashOf(b.path) + '.jpg');
    if (fs.existsSync(coverJpg)) fs.unlinkSync(coverJpg);
  } catch (e) { /* ignore */ }
  db.removeByPath(b.path);
  db.persist();
  return { ok: true };
}

function moveBook(id, targetDir) {
  const b = db.getById(id);
  if (!b) return { ok: false, error: '书籍不存在' };
  let dest = '';
  try {
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    dest = path.join(targetDir, b.filename);
    if (path.resolve(dest) === path.resolve(b.path)) return { ok: true, book: b };
    if (fs.existsSync(dest)) return { ok: false, error: '目标文件夹已有同名文件' };
    try {
      fs.renameSync(b.path, dest);
    } catch (e) {
      if (e.code === 'EXDEV') { fs.copyFileSync(b.path, dest); fs.unlinkSync(b.path); }
      else throw e;
    }
    db.updatePath(id, dest, path.dirname(dest), b.filename);
    db.persist();
    return { ok: true, book: db.getById(id) };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

// ---------- 阅读器窗口 ----------
const readerWins = new Set();
function openReader(id) {
  const b = db.getById(id);
  if (!b) return { ok: false, error: '书籍不存在' };
  if (!fs.existsSync(b.path)) return { ok: false, error: '文件不存在，可能已被移动或删除' };
  db.touchRead(id);
  db.persist();

  // 同一本书复用窗口
  for (const w of readerWins) {
    if (!w.isDestroyed() && w.bookId === id) {
      w.focus();
      return { ok: true };
    }
  }
  const win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 800, minHeight: 560,
    backgroundColor: '#f7f7f9',
    title: b.title || b.filename,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
      spellcheck: false,
    },
  });
  win.bookId = id;
  win.setMenuBarVisibility(false);
  readerWins.add(win);
  win.on('closed', () => readerWins.delete(win));
  const q = encodeURIComponent(String(id));
  win.loadFile(path.join(__dirname, 'src', 'reader.html'), { query: { id: q } });
  return { ok: true };
}

// MOBI/AZW HTML 缓存（v3：新增 HUFF/CDIC 解压 + 大书图片落盘，旧缓存全部作废）
const MOBI_CACHE_VER = 'v3';
function getMobiHtmlFile(b) {
  const stamp = Math.floor(b.mtime || 0);
  const f = path.join(cacheDir, `${MOBI_CACHE_VER}-${b.id}-${stamp}.html`);
  try {
    if (fs.existsSync(f) && fs.statSync(f).mtimeMs > Date.now() - 7 * 86400000) return f;
  } catch (e) { /* ignore */ }
  // 大书（如多册漫画套装）图片不 base64 内嵌，写入同名图片目录并用 elocal:// 引用
  const imgDir = f.replace(/\.html$/, '-img');
  const opts = { imgDir, imgUrl: (p) => elocalUrl(p) };
  const { html, toc } = mobi.parseHtml(b.path, opts);
  fs.writeFileSync(f, html, 'utf8');
  try { fs.writeFileSync(f.replace(/\.html$/, '.toc.json'), JSON.stringify(toc), 'utf8'); } catch (e) { /* ignore */ }
  return f;
}

// ---------- 窗口 ----------
let mainWin = null;
function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 1480, height: 920, minWidth: 1080, minHeight: 680,
    backgroundColor: '#f4f4f6',
    title: settings.libraryName,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
      spellcheck: false,
    },
  });
  mainWin.setMenuBarVisibility(false);
  mainWin.on('closed', () => { mainWin = null; });
  mainWin.loadFile(path.join(__dirname, 'src', 'index.html'));

  // 启动后自动增量扫描
  if (settings.rootDir) {
    console.log('[boot] auto scan scheduled');
    setTimeout(() => { doScan().catch((e) => { console.error('[scan] error', e); }); }, 800);
  }

  // 开发用：AGNES_SHOT=1 启动后自动截图主界面；AGNES_READER=<id> 再截阅读器
  if (process.env.AGNES_SHOT) {
    const shotDir = path.join(__dirname, 'test');
    const shotSave = async (wc, outPath, tries) => {
      for (let i = 0; i < (tries || 8); i++) {
        try {
          const img = await wc.capturePage();
          const png = img.toPNG();
          if (png && png.length > 800) { fs.writeFileSync(outPath, png); return true; }
        } catch (e) { /* retry */ }
        await sleep(1000);
      }
      return false;
    };
    setTimeout(async () => {
      try {
        if (mainWin && !mainWin.isDestroyed()) {
          mainWin.show();
          mainWin.focus();
          await sleep(1200);
          console.log('[shot] main =', await shotSave(mainWin.webContents, path.join(shotDir, 'ui-main.png')));
          // 滚到底部截分页栏
          await mainWin.webContents.executeJavaScript('(function(){var el=document.querySelector(".content"); if(el) el.scrollTop = el.scrollHeight; return "ok";})()').catch(() => {});
          await sleep(500);
          console.log('[shot] main-bottom =', await shotSave(mainWin.webContents, path.join(shotDir, 'ui-main-bottom.png')));
          // AGNES_HOVER="1"：真实鼠标悬停第 2 张卡片，验证只有它变化
          if (process.env.AGNES_HOVER) {
            const rct = await mainWin.webContents.executeJavaScript(`(function(){
              const cs=document.querySelectorAll('.card');
              if(cs.length<2) return null;
              const c=cs[1], g=document.querySelector('.grid'), r=c.getBoundingClientRect();
              const gr=g.getBoundingClientRect();
              return {x1:gr.left,y1:gr.top,x2:gr.right,y2:gr.bottom,
                      cx:r.left+r.width/2, cy:r.top+r.height/2, id:c.dataset.id};
            })()`).catch(() => null);
            if (rct) {
              const { x1, y1, x2, y2, cx, cy } = rct;
              const rx1 = Math.max(0, Math.floor(x1)), ry1 = Math.max(0, Math.floor(y1));
              const rx2 = Math.min(1280, Math.ceil(x2)), ry2 = Math.min(720, Math.ceil(y2));
              const rect = { x: rx1, y: ry1, width: rx2 - rx1, height: ry2 - ry1 };
              const grab = async (out) => {
                const img = await mainWin.webContents.capturePage(rect);
                fs.writeFileSync(out, img.toPNG());
                return out;
              };
              await sleep(300);
              await grab(path.join(shotDir, 'grid-norm.png'));
              await mainWin.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(cx), y: Math.round(cy), clickCount: 0 });
              await sleep(450);
              await grab(path.join(shotDir, 'grid-hover.png'));
              console.log('[shot] hover cards id =', rct.id, 'rect =', JSON.stringify(rect));
            }
          }

          // AGNES_PAGER="1"：实测翻页前后分页栏是否漂移（网格等高校验）
          if (process.env.AGNES_PAGER) {
            const probe = `(function(){
              const g=(s)=>{const e=document.querySelector(s); if(!e) return null; const r=e.getBoundingClientRect();
                return {x:Math.round(r.left*10)/10,y:Math.round(r.top*10)/10};};
              const grid=document.querySelector('.grid');
              return {prev:g('#prevPage'),next:g('#nextPage'),
                      gridH: grid?Math.round(grid.getBoundingClientRect().height*10)/10:null};
            })()`;
            const before = await mainWin.webContents.executeJavaScript(probe).catch(() => null);
            await mainWin.webContents.executeJavaScript('document.querySelector("#nextPage").click(); "ok"').catch(() => {});
            await sleep(800);
            const after = await mainWin.webContents.executeJavaScript(probe).catch(() => null);
            console.log('[pager] page1 =', JSON.stringify(before), ' page2 =', JSON.stringify(after));
            // 末页验证：跳到最大页，分页栏位置应与整页时一致
            await mainWin.webContents.executeJavaScript(`(function(){var i=document.querySelector('#pageJump');
              i.value=String(parseInt(i.max,10)); i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); return 'ok';})()`).catch(() => {});
            await sleep(800);
            const last = await mainWin.webContents.executeJavaScript(probe).catch(() => null);
            console.log('[pager] last  =', JSON.stringify(last));
          }
        }

        // AGNES_MOVE="<id>|<目标目录>"：真实移动 + 移回，验证文件系统操作
        const mv = process.env.AGNES_MOVE;
        if (mv) {
          const sep = mv.indexOf('|');
          const mid = parseInt(mv.slice(0, sep), 10);
          const targetDir = mv.slice(sep + 1);
          const b0 = db.getById(mid);
          if (b0) {
            const origDir = b0.dir;
            const r1 = moveBook(mid, targetDir);
            const ok1 = !!(r1.ok && r1.book && fs.existsSync(r1.book.path) && !fs.existsSync(b0.path));
            console.log('[move] out =', ok1, r1.book ? r1.book.path : '', r1.error || '');
            const r2 = moveBook(mid, origDir);
            const ok2 = !!(r2.ok && r2.book && fs.existsSync(r2.book.path));
            console.log('[move] back =', ok2, r2.error || '');
            db.persist();
          }
        }

        // AGNES_MODAL="detail,stats,settings,move"：依次打开弹窗截图
        const modals = (process.env.AGNES_MODAL || '').split(',').filter(Boolean);
        for (const modal of modals) {
          if (!mainWin || mainWin.isDestroyed()) break;
          let exec = '';
          if (modal === 'detail') exec = 'typeof openDetail === "function" ? openDetail(2) : "no-fn"';
          else if (modal === 'stats') exec = 'document.getElementById("btnStats").click()';
          else if (modal === 'settings') exec = 'document.getElementById("btnSettings").click()';
          else if (modal === 'move') exec = 'typeof openDetail === "function" ? openDetail(2).then(function(){ openMove(); }) : "no-fn"';
          else if (modal === 'search') exec = '(function(){var s=document.getElementById("searchInput"); s.value="MOBI"; s.dispatchEvent(new Event("input")); return "ok";})()';
          if (!exec) continue;
          await mainWin.webContents.executeJavaScript(exec).catch((e) => String(e));
          await sleep(modal === 'search' ? 1400 : (modal === 'move' || modal === 'stats' ? 1600 : 1200));
          console.log('[shot] modal', modal, '=', await shotSave(mainWin.webContents, path.join(shotDir, 'ui-' + modal + '.png')));
          if (modal !== 'search') {
            await mainWin.webContents.executeJavaScript('document.querySelectorAll(".modal-mask").forEach(function(m){ m.hidden = true; });').catch(() => {});
            await sleep(300);
          }
        }

        const rid = parseInt(process.env.AGNES_READER || '', 10);
        if (rid) {
          const r = openReader(rid);
          console.log('[shot] reader open', JSON.stringify(r));
          await sleep(9000);
          const rw = [...readerWins].find((w) => !w.isDestroyed());
          if (rw) {
            rw.show(); rw.focus();
            await sleep(1200);
            console.log('[shot] reader =', await shotSave(rw.webContents, path.join(shotDir, 'ui-reader.png')));
          }
        }
      } catch (e) {
        console.error('[shot] error', e);
      }
      app.quit();
    }, 8000);
  }
}

// ---------- IPC ----------
function registerIpc() {
  ipcMain.handle('settings:get', () => ({ ...settings }));
  ipcMain.handle('settings:save', (e, s) => {
    const rootChanged = s.rootDir && path.resolve(s.rootDir) !== path.resolve(settings.rootDir || '');
    settings.libraryName = String(s.libraryName || defaults.libraryName).slice(0, 60) || defaults.libraryName;
    settings.rootDir = String(s.rootDir || '');
    const pp = parseInt(s.perPage, 10);
    settings.perPage = Number.isFinite(pp) ? Math.min(200, Math.max(4, pp)) : 24;
    persistSettings();
    if (mainWin) mainWin.setTitle(settings.libraryName);
    return { ok: true, rootChanged };
  });
  ipcMain.handle('dialog:pick', async () => {
    const r = await dialog.showOpenDialog(mainWin || undefined, { properties: ['openDirectory'], title: '选择书籍根文件夹' });
    return r.canceled ? '' : (r.filePaths[0] || '');
  });

  ipcMain.handle('scan:run', () => doScan());
  ipcMain.handle('scan:cover-now', () => { runCoverQueue(); return { ok: true }; });

  ipcMain.handle('tree:get', () => {
    if (!settings.rootDir) return { root: '', tree: null, total: 0 };
    const tree = makeTree(db.distinctDirs(), settings.rootDir, (abs) => db.folderCount(abs, settings.rootDir));
    return { root: settings.rootDir, tree, total: db.folderCount(settings.rootDir, settings.rootDir) };
  });

  ipcMain.handle('books:list', (e, args) => {
    args = args || {};
    const r = db.listBooks({
      dir: args.dir || settings.rootDir,
      dirRoot: settings.rootDir,
      status: args.status || '',
      search: (args.search || '').trim(),
      page: Math.max(1, args.page || 1),
      perPage: settings.perPage,
    });
    return r;
  });
  ipcMain.handle('books:get', (e, id) => db.getById(id));
  ipcMain.handle('books:move', (e, { id, targetDir }) => moveBook(id, targetDir));
  ipcMain.handle('books:delete', (e, id) => deleteBook(id));
  ipcMain.handle('books:status', (e, { id, status }) => { db.setStatus(id, status); db.persist(); return { ok: true }; });
  ipcMain.handle('books:progress', (e, { id, progress, location, status }) => {
    db.updateProgress(id, { progress, location, status });
    return { ok: true };
  });
  ipcMain.handle('books:seconds', (e, { id, seconds }) => { db.addReadSeconds(id, seconds); return { ok: true }; });

  ipcMain.handle('stats:get', () => db.stats());
  ipcMain.handle('bookmarks:list', (e, bookId) => db.listBookmarks(bookId));
  ipcMain.handle('bookmarks:add', (e, { bookId, location, label }) => db.addBookmark(bookId, location, label));
  ipcMain.handle('bookmarks:remove', (e, id) => { db.removeBookmark(id); return { ok: true }; });

  ipcMain.handle('shell:reveal', (e, p) => { if (p && fs.existsSync(p)) shell.showItemInFolder(p); return { ok: true }; });

  ipcMain.handle('reader:open', (e, id) => openReader(id));

  ipcMain.handle('reader:load', (e, id) => {
    const b = db.getById(id);
    if (!b) return { ok: false, error: '书籍不存在' };
    if (!fs.existsSync(b.path)) return { ok: false, error: '文件已被移动或删除' };
    const base = {
      ok: true, id: b.id, title: b.title, author: b.author, ext: b.ext,
      path: b.path, progress: b.progress || 0, location: b.location || '',
      status: b.status, readSeconds: b.read_seconds || 0,
      bookmarks: db.listBookmarks(b.id),
      url: elocalUrl(b.path),
    };
    try {
      const ext = (b.ext || '').toLowerCase();
      if (ext === 'txt') {
        base.text = decodeText(fs.readFileSync(b.path));
        base.type = 'txt';
      } else if (ext === 'mobi' || ext === 'azw' || ext === 'azw3') {
        base.htmlFile = getMobiHtmlFile(b);
        base.type = 'mobi';
        try {
          const tocPath = base.htmlFile.replace(/\.html$/, '.toc.json');
          base.toc = fs.existsSync(tocPath) ? JSON.parse(fs.readFileSync(tocPath, 'utf8')) : [];
        } catch (er) { base.toc = []; }
      } else if (ext === 'epub') {
        base.type = 'epub';
      } else if (ext === 'pdf') {
        base.type = 'pdf';
      } else {
        return { ok: false, error: '暂不支持的格式：' + ext };
      }
      return base;
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  // 目录树里所有子目录（供「移动到…」选择）
  ipcMain.handle('dirs:list', () => {
    if (!settings.rootDir) return [];
    const tree = makeTree(db.distinctDirs(), settings.rootDir, () => 0);
    const out = [];
    const walkNode = (n, prefix) => {
      out.push({ abs: n.abs, label: (prefix ? prefix + ' / ' : '') + n.name });
      (n.childList || []).forEach((c) => walkNode(c, (prefix ? prefix + ' / ' : '') + n.name));
    };
    walkNode(tree, '');
    return out;
  });
}

// ---------- 生命周期 ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWin) { if (mainWin.isMinimized()) mainWin.restore(); mainWin.focus(); }
  });

  app.whenReady().then(async () => {
    // elocal 协议
    session.defaultSession.protocol.handle('elocal', async (req) => {
      try {
        const p = elocalToPath(req.url);
        if (!fs.existsSync(p)) return new Response('Not Found', { status: 404 });
        return net.fetch(require('url').pathToFileURL(p).toString());
      } catch (e) {
        return new Response('Error', { status: 500 });
      }
    });

    loadSettings();
    coversDir = path.join(app.getPath('userData'), 'covers');
    cacheDir = path.join(app.getPath('userData'), 'mobi-cache');
    fs.mkdirSync(coversDir, { recursive: true });
    fs.mkdirSync(cacheDir, { recursive: true });
    await db.init(app.getPath('userData'));
    registerIpc();
    console.log('[boot] db ready, settings =', JSON.stringify({ root: settings.rootDir, perPage: settings.perPage }));
    createMainWindow();
  });

  app.on('second-window', () => { /* noop */ });

  app.on('window-all-closed', () => {
    db.persist();
    app.quit();
  });
  app.on('before-quit', () => {
    db.persist();
    try { if (snapState.win && !snapState.win.isDestroyed()) snapState.win.destroy(); } catch (e) { /* ignore */ }
  });
}
