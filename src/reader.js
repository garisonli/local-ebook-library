// 内嵌阅读器逻辑：EPUB / PDF / TXT / MOBI / AZW3
/* global api, pdfjsLib, ePub */
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const bookId = parseInt(params.get('id'), 10);

let bookData = null;
let mode = ''; // epub | pdf | col
const cur = { progress: 0, location: '' };
let tocItems = [];

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function clamp01(x) { return Math.min(1, Math.max(0, x || 0)); }

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.onload = resolve;
    s.onerror = () => reject(new Error('脚本加载失败'));
    document.head.appendChild(s);
  });
}

// ---------- 进度上报 ----------
let saveTimer = null;
function updateProgressUi() {
  const pct = Math.round(cur.progress * 100);
  $('progText').textContent = pct + '%';
  $('progFill').style.width = pct + '%';
}
function setProgress(p, loc) {
  if (typeof p === 'number' && !Number.isNaN(p)) cur.progress = clamp01(p);
  if (loc != null && loc !== '') cur.location = String(loc);
  updateProgressUi();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => api.saveProgress(bookId, cur.progress, cur.location), 700);
}

// ---------- 阅读时长 ----------
let lastTick = Date.now();
function flushSeconds() {
  const d = (Date.now() - lastTick) / 1000;
  if (d >= 1) api.addSeconds(bookId, d);
  lastTick = Date.now();
}
setInterval(() => { if (!document.hidden) flushSeconds(); }, 10000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { flushSeconds(); clearTimeout(saveTimer); api.saveProgress(bookId, cur.progress, cur.location); }
  else lastTick = Date.now();
});
window.addEventListener('beforeunload', () => {
  flushSeconds();
  try { api.saveProgress(bookId, cur.progress, cur.location); } catch (e) { /* ignore */ }
});

// ---------- EPUB ----------
let epubBook = null, rendition = null;
let epubRestored = true;
let epubPagesTotal = 0;

async function initEpub() {
  mode = 'epub';
  await loadScript(api.assets.jszip); // epubjs 解压需要全局 JSZip
  await loadScript(api.assets.epubjs);
  $('epubView').hidden = false;
  epubBook = ePub(bookData.url);
  rendition = epubBook.renderTo('epubView', {
    width: '100%', height: '100%', flow: 'paginated', spread: 'none',
  });
  rendition.themes.register('light', {
    body: { color: '#26262e', background: '#f7f7f9' },
    a: { color: '#c93b5b' },
  });
  rendition.themes.register('dark', {
    body: { color: '#cfcfd6', background: '#1b1b21' },
    a: { color: '#e2607e' },
  });
  rendition.themes.select(document.body.classList.contains('dark') ? 'dark' : 'light');
  if (fontPx) rendition.themes.fontSize(fontPx + 'px');

  // 单文件/短书（spine 只有 1-2 项）跳过 locations：生成出来只有 1 个分页点，
  // 翻一页就 100%，进度完全失真。这类书退回章节/百分比兜底。
  const spineCount = (epubBook && epubBook.spine && epubBook.spine.spineItems)
    ? epubBook.spine.spineItems.length : 99;
  if (spineCount <= 2) { $('pageTotal').textContent = ''; }
  else epubBook.locations.generate(600).then(() => {
    epubPagesTotal = epubBook.locations.total || 0;
    const cfi = cur.location || startAt;
    if (epubPagesTotal && cfi && epubBook.locations.percentageFromCfi) {
      const p = epubBook.locations.percentageFromCfi(cfi);
      if (typeof p === 'number' && !Number.isNaN(p)) {
        setProgress(p, cfi);
        $('pageInput').value = String(Math.max(1, Math.round(p * epubPagesTotal)));
      }
    }
    if (epubPagesTotal) $('pageTotal').textContent = '/ ' + epubPagesTotal;
  }).catch(() => { /* 无 locations 也照常阅读 */ });

  const startAt = bookData.location && bookData.location.indexOf('epubcfi') >= 0
    ? bookData.location : undefined;
  await rendition.display(startAt);

  rendition.on('relocated', (loc) => {
    const s = loc && loc.start;
    if (!s) return;
    let p = (typeof s.percentage === 'number') ? s.percentage : null;
    if ((p === null || p === undefined) && epubBook.locations && epubBook.locations.total) {
      p = epubBook.locations.percentageFromCfi(s.cfi);
    }
    if (p === null || p === undefined) p = cur.progress;
    if (epubRestored && p < 0.01 && cur.progress > 0.02) p = cur.progress;
    epubRestored = false;
    // locations 未就绪时不要急着定进度，避免把占位的 100% 当真进度
    if (epubBook.locations && epubBook.locations.total) {
      setProgress(p, s.cfi);
      const pageNo = Math.max(1, Math.round(cur.progress * epubPagesTotal));
      $('pageInput').value = String(pageNo);
      $('pageTotal').textContent = '/ ' + epubPagesTotal;
    } else {
      cur.location = s.cfi;      // 只记住位置，不推进度
      epubRestored = false;
      $('pageInput').value = '…';
      $('pageTotal').textContent = s.label ? String(s.label) : '';
    }
  });

  try {
    await epubBook.loaded.navigation;
    const flat = [];
    const walk = (arr, lv) => (arr || []).forEach((t) => {
      flat.push({ label: t.label.trim() || '（无标题）', href: t.href, level: lv });
      walk(t.subitems, lv + 1);
    });
    (epubBook.navigation && epubBook.navigation.toc || []).length !== 0
      ? walk(epubBook.navigation.toc, 0)
      : walk((epubBook.spine && []), 0);
    tocItems = flat;
    renderToc();
  } catch (e) { /* 无目录 */ }
}

// ---------- PDF ----------
let pdfDoc = null, pdfPage = 1, pdfRenderTask = null;
let pdfjsReady = null;
function ensurePdfjs() {
  if (!pdfjsReady) {
    pdfjsReady = loadScript(api.assets.pdfjs).then(() => {
      pdfjsLib.GlobalWorkerOptions.workerSrc = api.assets.pdfWorker;
    });
  }
  return pdfjsReady;
}

async function initPdf() {
  mode = 'pdf';
  await ensurePdfjs();
  $('pdfView').hidden = false;
  pdfDoc = await pdfjsLib.getDocument({
    url: bookData.url,
    cMapUrl: api.assets.pdfCmaps,
    cMapPacked: true,
    standardFontDataUrl: api.assets.pdfFonts,
    isEvalSupported: false,
  }).promise;
  $('pageTotal').textContent = '/ ' + pdfDoc.numPages;
  let start = parseInt(bookData.location, 10);
  if (!Number.isFinite(start) || start < 1 || start > pdfDoc.numPages) {
    start = bookData.progress > 0.001
      ? Math.min(pdfDoc.numPages, Math.max(1, Math.round(bookData.progress * pdfDoc.numPages)))
      : 1;
  }
  await renderPdfPage(start);
  buildPdfOutline();
}

async function renderPdfPage(n) {
  n = Math.min(pdfDoc.numPages, Math.max(1, n));
  const page = await pdfDoc.getPage(n);
  const view = $('pdfView');
  const boxW = view.clientWidth - 44;
  const boxH = view.clientHeight - 44;
  const vp0 = page.getViewport({ scale: 1 });
  const scale = Math.min(boxW / vp0.width, boxH / vp0.height);
  const vp = page.getViewport({ scale });
  const cv = $('pdfCanvas');
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.ceil(vp.width * dpr);
  cv.height = Math.ceil(vp.height * dpr);
  cv.style.width = vp.width + 'px';
  cv.style.height = vp.height + 'px';
  if (pdfRenderTask) { try { pdfRenderTask.cancel(); } catch (e) { /* ignore */ } }
  pdfRenderTask = page.render({
    canvasContext: cv.getContext('2d'),
    viewport: vp,
    transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
  });
  try { await pdfRenderTask.promise; } catch (e) { if (e && e.name !== 'RenderingCancelledException') throw e; }
  pdfPage = n;
  $('pageInput').value = String(n);
  $('pageTotal').textContent = '/ ' + pdfDoc.numPages;
  view.scrollTop = 0;
  setProgress(n / pdfDoc.numPages, String(n));
}

async function buildPdfOutline() {
  try {
    const outline = await pdfDoc.getOutline();
    if (!outline || !outline.length) return;
    const items = [];
    for (const it of outline) {
      let dest = it.dest;
      try {
        if (typeof dest === 'string') dest = await pdfDoc.getDestination(dest);
        let page = null;
        if (Array.isArray(dest) && dest[0]) page = (await pdfDoc.getPageIndex(dest[0])) + 1;
        items.push({ label: it.title || '（无标题）', page });
      } catch (e) { items.push({ label: it.title || '（无标题）', page: null }); }
    }
    tocItems = items;
    renderToc();
  } catch (e) { /* 无目录 */ }
}

// ---------- TXT / MOBI（CSS 分栏分页） ----------
let colIdx = 0, colTotal = 1, colW = 0;

function colLayout() {
  const wrap = $('colWrap');
  const stage = $('stage');
  const flow = $('flow');
  const w = wrap.clientWidth;
  const h = wrap.clientHeight;
  if (!w || !h) return;
  colW = Math.max(240, w - 64);
  stage.style.width = colW + 'px';
  stage.style.height = h + 'px';
  flow.style.width = colW + 'px';
  flow.style.height = h + 'px';
  flow.style.columnWidth = colW + 'px';
  flow.style.columnGap = '0px';
  void flow.offsetHeight; // 强制重排
  colTotal = Math.max(1, Math.round(flow.scrollWidth / colW));
}

function colGoTo(i) {
  colIdx = Math.min(colTotal - 1, Math.max(0, i));
  $('flow').style.transform = 'translateX(' + (-colIdx * colW) + 'px)';
  $('pageInput').value = String(colIdx + 1);
  $('pageTotal').textContent = '/ ' + colTotal;
  setProgress((colIdx + 1) / colTotal, String(colIdx));
}

function colAnchorIdx(id) {
  const el = $('flow').querySelector('[id="' + String(id).replace(/"/g, '') + '"]');
  if (!el) return null;
  return Math.round(el.offsetLeft / colW);
}

async function initCol() {
  mode = 'col';
  $('colWrap').hidden = false;
  const flow = $('flow');
  let content = '';
  let plain = false;
  if (bookData.type === 'txt') {
    plain = true;
    content = esc(bookData.text || '');
  } else {
    let html = String(bookData.html || '');
    if (!html && bookData.htmlFile) {
      // MOBI/AZW3：读取主进程生成的 HTML 缓存文件
      try {
        const resp = await fetch(api.localUrl(bookData.htmlFile));
        html = await resp.text();
      } catch (e) {
        throw new Error('正文加载失败：' + (e && e.message || e));
      }
    }
    html = String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<link\b[^>]*>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '');
    const m = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    if (m) content = m[1];
    else content = html;
  }
  flow.style.whiteSpace = plain ? 'pre-wrap' : 'normal';
  flow.innerHTML = '<div class="pginner">' + content + '</div>';

  colLayout();
  let start = parseInt(bookData.location, 10);
  if (!Number.isFinite(start) || start < 0 || start >= colTotal) {
    start = bookData.progress > 0.001 ? Math.round(bookData.progress * colTotal) - 1 : 0;
    if (!Number.isFinite(start) || start < 0) start = 0;
  }
  colGoTo(start);

  if (bookData.toc && bookData.toc.length) {
    tocItems = bookData.toc.map((t) => ({ label: t.label, id: t.id, level: 0 }));
    renderToc();
  }
}

// ---------- 侧栏 / 目录 / 书签 ----------
function renderToc() {
  const el = $('tocList');
  if (!tocItems.length) { el.innerHTML = '<div class="hint">本书没有目录</div>'; return; }
  el.innerHTML = tocItems.map((t, i) =>
    `<button class="toc-item ${t.level ? 'lv2' : ''}" data-i="${i}">${esc(t.label)}</button>`
  ).join('');
  el.querySelectorAll('.toc-item').forEach((b) => {
    b.addEventListener('click', () => tocJump(+b.dataset.i));
  });
}

async function tocJump(i) {
  const t = tocItems[i];
  if (!t) return;
  try {
    if (mode === 'epub' && t.href) await rendition.display(t.href);
    else if (mode === 'pdf' && t.page) await renderPdfPage(t.page);
    else if (mode === 'col' && t.id) {
      const idx = colAnchorIdx(t.id);
      if (idx !== null && idx >= 0) colGoTo(idx);
    }
  } catch (e) { /* ignore */ }
}

function timeStr(ts) {
  const d = new Date(ts);
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function refreshBookmarks() {
  const list = await api.listBookmarks(bookId);
  const el = $('bmList');
  if (!list.length) { el.innerHTML = '<div class="hint">还没有书签</div>'; return; }
  el.innerHTML = list.map((b) => `
    <div class="bm-item">
      <button class="goto" data-loc="${esc(b.location)}">${esc(b.label || '书签')}</button>
      <span class="time">${timeStr(b.created_at)}</span>
      <button class="del" data-id="${b.id}" title="删除">✕</button>
    </div>`).join('');
  el.querySelectorAll('.goto').forEach((g) => {
    g.addEventListener('click', () => jumpToLocation(g.dataset.loc));
  });
  el.querySelectorAll('.del').forEach((d) => {
    d.addEventListener('click', async () => {
      await api.removeBookmark(+d.dataset.id);
      refreshBookmarks();
    });
  });
}

async function jumpToLocation(loc) {
  if (!loc) return;
  if (mode === 'epub') { if (loc.indexOf('epubcfi') >= 0) await rendition.display(loc); return; }
  const n = parseInt(loc, 10);
  if (!Number.isFinite(n)) return;
  if (mode === 'pdf') await renderPdfPage(n);
  else if (mode === 'col') colGoTo(n);
}

function currentBookmarkLabel() {
  const pct = Math.round(cur.progress * 100);
  if (mode === 'pdf') return `第 ${pdfPage} 页（${pct}%）`;
  if (mode === 'col') return `第 ${colIdx + 1} 页（${pct}%）`;
  return `进度 ${pct}%`;
}

// ---------- 顶栏控制 ----------
let fontPx = 18;

function doPrev() {
  if (mode === 'epub') rendition.prev();
  else if (mode === 'pdf') renderPdfPage(pdfPage - 1);
  else if (mode === 'col') colGoTo(colIdx - 1);
}
function doNext() {
  if (mode === 'epub') rendition.next();
  else if (mode === 'pdf') renderPdfPage(pdfPage + 1);
  else if (mode === 'col') colGoTo(colIdx + 1);
}

function applyFont(delta) {
  fontPx = Math.min(32, Math.max(12, fontPx + delta));
  if (mode === 'epub') { if (rendition) rendition.themes.fontSize(fontPx + 'px'); return; }
  if (mode === 'col') {
    const frac = colTotal > 1 ? (colIdx + 1) / colTotal : 1;
    $('flow').style.fontSize = fontPx + 'px';
    colLayout();
    colGoTo(Math.round(frac * colTotal) - 1);
  }
}

function applyTheme() {
  const dark = document.body.classList.toggle('dark');
  $('btnTheme').textContent = dark ? '☀️' : '🌙';
  if (mode === 'epub' && rendition) rendition.themes.select(dark ? 'dark' : 'light');
}

function jumpFromInput() {
  const v = parseInt($('pageInput').value, 10);
  if (!Number.isFinite(v)) return;
  if (mode === 'pdf') renderPdfPage(v);
  else if (mode === 'col') colGoTo(v - 1);
  else if (mode === 'epub') rendition.gotoPercentage(Math.min(100, Math.max(0, v)) / 100);
}

function bindControls() {
  $('btnClose').addEventListener('click', () => {
    flushSeconds();
    clearTimeout(saveTimer);
    api.saveProgress(bookId, cur.progress, cur.location);
    setTimeout(() => window.close(), 60);
  });
  $('btnPrev').addEventListener('click', doPrev);
  $('btnNext').addEventListener('click', doNext);
  $('pageInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') jumpFromInput(); });
  $('fontMinus').addEventListener('click', () => applyFont(-2));
  $('fontPlus').addEventListener('click', () => applyFont(2));
  $('btnTheme').addEventListener('click', applyTheme);
  $('btnSide').addEventListener('click', () => $('side').classList.toggle('hidden'));

  document.querySelectorAll('.side-tabs button').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.side-tabs button').forEach((x) => x.classList.toggle('on', x === b));
      $('tocList').hidden = b.dataset.tab !== 'toc';
      $('bmList').hidden = b.dataset.tab !== 'bm';
    });
  });

  $('btnAddBm').addEventListener('click', async () => {
    if (!cur.location && !cur.progress) return;
    await api.addBookmark(bookId, cur.location, currentBookmarkLabel());
    document.querySelectorAll('.side-tabs button').forEach((x) => x.classList.toggle('on', x.dataset.tab === 'bm'));
    $('tocList').hidden = true;
    $('bmList').hidden = false;
    refreshBookmarks();
    toast2('已添加书签');
  });

  document.addEventListener('keydown', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); doNext(); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); doPrev(); }
    else if (e.key === '+' || e.key === '=') applyFont(2);
    else if (e.key === '-') applyFont(-2);
  });

  let rsTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(rsTimer);
    rsTimer = setTimeout(() => {
      if (mode === 'col') {
        const frac = colTotal > 1 ? (colIdx + 1) / colTotal : 1;
        colLayout();
        colGoTo(Math.round(frac * colTotal) - 1);
      } else if (mode === 'pdf' && pdfDoc) {
        renderPdfPage(pdfPage);
      }
    }, 200);
  });
}

let toastT = null;
function toast2(msg) {
  let t = document.getElementById('rtoast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'rtoast';
    t.style.cssText = 'position:fixed;left:50%;bottom:34px;transform:translateX(-50%);background:rgba(30,26,42,.92);color:#fff;padding:9px 20px;border-radius:18px;font-size:13.5px;z-index:99';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(toastT);
  toastT = setTimeout(() => { t.style.display = 'none'; }, 1800);
}

// ---------- 启动 ----------
async function boot() {
  if (!bookId) { $('rLoading').textContent = '缺少书籍 ID'; return; }
  bookData = await api.readerLoad(bookId);
  if (!bookData || !bookData.ok) {
    $('rLoading').textContent = (bookData && bookData.error) || '打开失败';
    return;
  }
  document.title = bookData.title || '阅读';
  $('rTitle').textContent = bookData.title || bookData.path;
  $('rAuthor').textContent = bookData.author || '';
  cur.progress = bookData.progress || 0;
  cur.location = bookData.location || '';
  updateProgressUi();
  bindControls();
  refreshBookmarks();

  try {
    if (bookData.type === 'epub') await initEpub();
    else if (bookData.type === 'pdf') await initPdf();
    else await initCol();
    $('rLoading').style.display = 'none';
  } catch (e) {
    $('rLoading').textContent = '打开失败：' + (e && e.message ? e.message : e);
  }
}
boot();
