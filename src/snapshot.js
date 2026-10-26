// 封面快照：按主进程指令渲染第一页并回传
/* global api, ePub, pdfjsLib */
const $ = (id) => document.getElementById(id);

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.onload = resolve;
    s.onerror = () => reject(new Error('脚本加载失败: ' + url));
    document.head.appendChild(s);
  });
}

let pdfjsReady = null;
function ensurePdfjs() {
  if (!pdfjsReady) {
    pdfjsReady = loadScript(api.assets.pdfjs).then(() => {
      pdfjsLib.GlobalWorkerOptions.workerSrc = api.assets.pdfWorker;
    });
  }
  return pdfjsReady;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function reset() {
  $('canvasBox').style.display = 'none';
  $('epubBox').style.display = 'none';
  $('htmlBox').style.display = 'none';
  $('textBox').style.display = 'none';
}

function hasInk(cv) {
  // 检测画布是否有内容（跳过空白扉页用）
  try {
    const ctx = cv.getContext('2d');
    const w = cv.width, h = cv.height;
    const data = ctx.getImageData(0, 0, w, h).data;
    const stepX = Math.max(1, Math.floor(w / 120));
    const stepY = Math.max(1, Math.floor(h / 160));
    let dark = 0, total = 0;
    for (let y = 0; y < h; y += stepY) {
      for (let x = 0; x < w; x += stepX) {
        const idx = (y * w + x) * 4;
        total++;
        if (data[idx] < 230 || data[idx + 1] < 230 || data[idx + 2] < 230) dark++;
      }
    }
    return total > 0 && dark / total >= 0.002;
  } catch (e) {
    return true; // 检测失败时当作有内容，避免误判
  }
}

async function renderPdf(url) {
  await ensurePdfjs();
  $('canvasBox').style.display = 'block';
  const doc = await pdfjsLib.getDocument({
    url,
    cMapUrl: api.assets.pdfCmaps,
    cMapPacked: true,
    standardFontDataUrl: api.assets.pdfFonts,
    isEvalSupported: false,
  }).promise;
  const cv = $('cv');
  const dpr = window.devicePixelRatio || 1;
  // 从第 1 页起找第一个非空白页做封面（很多 PDF 扉页本身是空白的）
  const maxTry = Math.min(5, doc.numPages);
  let hasContent = false;
  for (let p = 1; p <= maxTry; p++) {
    const page = await doc.getPage(p);
    const vp0 = page.getViewport({ scale: 1 });
    const scale = Math.min(456 / vp0.width, 616 / vp0.height);
    const vp = page.getViewport({ scale });
    cv.width = Math.ceil(vp.width * dpr);
    cv.height = Math.ceil(vp.height * dpr);
    cv.style.width = vp.width + 'px';
    cv.style.height = vp.height + 'px';
    await page.render({ canvasContext: cv.getContext('2d'), viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null }).promise;
    await sleep(120);
    if (hasInk(cv)) { hasContent = true; break; }
  }
  await doc.destroy();
  await sleep(150);
  if (!hasContent) throw new Error('PDF 前几页均为空白，无法生成快照');
}

let epubjsReady = null;
function ensureEpubjs() {
  if (!epubjsReady) {
    epubjsReady = loadScript(api.assets.jszip) // epubjs 解压需要全局 JSZip
      .then(() => loadScript(api.assets.epubjs));
  }
  return epubjsReady;
}

async function renderEpub(url) {
  await ensureEpubjs();
  console.log('[snapshot] epubjs loaded, opening', url);
  $('epubBox').style.display = 'block';
  const book = ePub(); // 不带参数：不自动 open，便于拦截底层错误
  book.opened.catch((e) => console.log('[snapshot] opened error:', e && e.message));
  const openP = book.open(url);
  openP.catch((e) => console.log('[snapshot] ROOT open error:', e && e.message, '| status', e && e.status,
    '|', String((e && e.stack) || e).slice(0, 600)));
  ['manifest', 'spine', 'metadata', 'cover', 'navigation', 'resources', 'displayOptions'].forEach((k) => {
    book.loaded[k].then(() => console.log('[snapshot] loaded:', k)).catch((e) => console.log('[snapshot] load err:', k, String(e).slice(0, 200)));
  });
  const ready = await Promise.race([
    openP.then(() => book.ready),
    new Promise((_, rej) => setTimeout(() => rej(new Error('book.ready timeout')), 12000)),
  ]);
  console.log('[snapshot] book ready');
  const rendition = book.renderTo('epubBox', { width: 456, height: 616, flow: 'paginated', spread: false });
  await Promise.race([rendition.display(), sleep(9000)]);
  await sleep(600);

  // 把 iframe 里的正文内联成主框架静态 DOM（隐藏窗口不合成 iframe，但主框架 DOM 可靠）
  let inlined = false;
  try {
    const fr = document.querySelector('#epubBox iframe');
    const body = fr && fr.contentDocument && fr.contentDocument.body;
    const html = body ? body.innerHTML : '';
    console.log('[snapshot] iframe body len =', html.length);
    if (html.length > 20) {
      $('epubBox').innerHTML = '';
      const div = document.createElement('div');
      div.style.cssText = 'font-size:15.5px;line-height:1.8;color:#222;padding:10px 12px;white-space:normal;';
      div.innerHTML = html
        .replace(/<link\b[^>]*>/gi, '')
        .replace(/<script[\s\S]*?<\/script>/gi, '');
      div.querySelectorAll('img').forEach((im) => {
        const s = im.getAttribute('src') || '';
        if (s && !/^(data:|https?:|blob:)/.test(s)) im.removeAttribute('src');
      });
      div.querySelectorAll('a').forEach((a) => { a.style.color = '#222'; a.style.textDecoration = 'none'; });
      $('epubBox').appendChild(div);
      inlined = true;
    }
  } catch (e) { console.log('[snapshot] inline err', String(e).slice(0, 200)); }

  try { rendition.destroy(); } catch (e) { /* ignore */ }
  await sleep(400);
  if (!inlined) throw new Error('EPUB 首页内容为空，无法生成快照');
}

function renderHtml(html) {
  $('htmlBox').style.display = 'block';
  const clean = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<link\b[^>]*>/gi, '');
  $('htmlBox').innerHTML = clean;
  return sleep(500);
}

function renderText(text) {
  $('textBox').style.display = 'block';
  $('textBox').textContent = String(text || '');
  return sleep(150);
}

api.onSnapshotRender(async (payload) => {
  console.log('[snapshot] received', payload && payload.type);
  reset();
  try {
    if (payload.type === 'pdf') await renderPdf(payload.url);
    else if (payload.type === 'epub') await renderEpub(payload.url);
    else if (payload.type === 'html') await renderHtml(payload.html);
    else if (payload.type === 'text') await renderText(payload.text);
    else throw new Error('未知类型 ' + payload.type);
    api.snapshotReply({ ch: 'snapshot:ready' });
  } catch (e) {
    api.snapshotReply({ ch: 'snapshot:error', error: String(e && e.message || e) });
  }
});
