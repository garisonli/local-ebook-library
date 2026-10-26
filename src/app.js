// 主界面逻辑
/* global api */
const $ = (id) => document.getElementById(id);

const state = {
  settings: null,
  dir: '',           // 当前选中文件夹（abs），'' = 全部
  status: '',        // 标签过滤
  search: '',
  page: 1,
  tree: null,
  root: '',
  total: 0,
  books: [],
  detailId: null,
  scanning: false,
};

let searchTimer = null;
let toastTimer = null;

function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmtTime(sec) {
  sec = Math.round(sec || 0);
  if (sec < 60) return sec + ' 秒';
  if (sec < 3600) return Math.floor(sec / 60) + ' 分钟';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

// ---------- 左侧树 ----------
// 展开状态：state.expanded 存放已展开节点的 rel（'' = 根）
// 默认只展开到顶层文件夹（根的一层），深层目录默认收起
function defaultExpanded(tree) {
  const s = new Set(['']);
  (tree.childList || []).forEach((c) => s.add(c.rel));
  return s;
}

function collectRels(n, out) {
  out.add(n.rel);
  (n.childList || []).forEach((c) => collectRels(c, out));
  return out;
}

function renderTree() {
  const el = $('tree');
  if (!state.tree) {
    el.innerHTML = '<div class="form-hint" style="padding:6px 8px">请先设置书籍文件夹</div>';
    return;
  }
  if (!state.expanded) state.expanded = defaultExpanded(state.tree);
  const total = state.tree.count;
  const isOpen = (rel) => state.expanded.has(rel);

  const rowHtml = (n, isRoot) => {
    const hasKids = n.childList && n.childList.length;
    const active = (isRoot && !state.dir) || (!isRoot && state.dir === n.abs);
    const arrow = hasKids ? (isRoot ? '▼' : '▾') : '·';
    const shut = hasKids && !isOpen(n.rel);
    return `<div class="tree-row ${active ? 'active' : ''}" data-abs="${esc(isRoot ? '' : n.abs)}" data-rel="${esc(n.rel)}" data-kids="${hasKids ? 1 : 0}">
      <span class="arrow ${shut ? 'shut' : ''}">${arrow}</span>
      <span class="ico">${isRoot ? '📚' : '📁'}</span>
      <span class="name">${esc(isRoot ? '全部书籍' : n.name)}</span>
      <span class="count">${isRoot ? total : n.count}</span>
    </div>`;
  };

  const kids = (n) => (n.childList || []).map((c) => `
    <div class="tree-node">
      ${rowHtml(c, false)}
      ${c.childList && c.childList.length && isOpen(c.rel)
        ? `<div class="tree-children">${kids(c)}</div>` : ''}
    </div>`).join('');

  let html = rowHtml(state.tree, true);
  if (isOpen('')) html += `<div class="tree-children">${kids(state.tree)}</div>`;
  el.innerHTML = html;

  el.querySelectorAll('.tree-row').forEach((row) => {
    row.querySelector('.arrow').addEventListener('click', (e) => {
      e.stopPropagation();
      if (row.dataset.kids !== '1') return;
      const rel = row.dataset.rel;
      if (state.expanded.has(rel)) state.expanded.delete(rel);
      else state.expanded.add(rel);
      renderTree();
    });
    row.addEventListener('click', () => {
      state.dir = row.dataset.abs || '';
      state.page = 1;
      renderTree();
      loadBooks();
    });
  });

  // 全部展开 / 全部收起
  $('treeExpandAll').onclick = () => {
    state.expanded = collectRels(state.tree, new Set());
    renderTree();
  };
  $('treeCollapseAll').onclick = () => {
    state.expanded = new Set();
    renderTree();
  };
}

// ---------- 书籍网格 ----------
function coverImg(book) {
  if (book.cover_path) return `<img src="${api.localUrl(book.cover_path)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><div class="cover-ph" style="display:none">📖</div>`;
  return `<div class="cover-ph">📖</div>`;
}

function renderBooks() {
  const grid = $('grid');
  const list = state.books;
  const per = state.settings.perPage;
  const pages = Math.max(1, Math.ceil(state.total / per));
  const paged = state.total > per;
  $('emptyState').hidden = list.length > 0;
  $('pager').hidden = !paged;
  if (!list.length) {
    grid.innerHTML = '';
    if (state.search) $('emptyText').textContent = `没有找到与「${state.search}」相关的书籍`;
    else if (!state.settings.rootDir) $('emptyText').textContent = '请先在设置中选择书籍文件夹';
    else $('emptyText').textContent = '这个文件夹里还没有电子书';
    $('btnEmptyScan').hidden = !(state.settings.rootDir && !state.search);
    return;
  }
  let html = list.map((b) => {
    const ext = (b.ext || '').toLowerCase();
    const prog = Math.round((b.progress || 0) * 100);
    const stTag = b.status === '已读'
      ? '<div class="read-tag">✓ 已读</div>'
      : (b.status === '在读' ? '<div class="read-tag reading">在读</div>' : '');
    // 进度条槽位恒定渲染（无进度时留空槽），保证所有卡片等高，翻页时网格高度不变
    const progBar = `<div class="card-prog">${(prog > 0 && prog < 100) ? `<i style="width:${prog}%"></i>` : ''}</div>`;
    return `<div class="card" data-id="${b.id}">
      <div class="card-cover">
        ${coverImg(b)}
        <span class="badge ${esc(ext)}">${esc(ext.toUpperCase())}</span>
        ${stTag}
      </div>
      ${progBar}
      <div class="card-info">
        <div class="card-title" title="${esc(b.title)}">${esc(b.title || b.filename)}</div>
        <div class="card-author">${esc(b.author || '未知作者')}</div>
      </div>
    </div>`;
  }).join('');

  // 末页用隐形空卡补齐到整页：所有页网格高度一致，底部分页栏翻页时不上下跳动
  if (paged && list.length < per) {
    const filler = '<div class="card filler" aria-hidden="true"><div class="card-cover"></div><div class="card-prog"></div><div class="card-info"><div class="card-title"></div><div class="card-author"></div></div></div>';
    html += filler.repeat(per - list.length);
  }
  grid.innerHTML = html;

  grid.querySelectorAll('.card:not(.filler)').forEach((c) => {
    c.addEventListener('click', () => openDetail(+c.dataset.id));
  });

  // 分页
  $('pageTotal').textContent = String(pages);
  const jumpInput = $('pageJump');
  jumpInput.max = String(pages);
  if (document.activeElement !== jumpInput) jumpInput.value = String(state.page);
  $('pageInfo').textContent = `共 ${state.total} 本`;
  $('prevPage').disabled = state.page <= 1;
  $('nextPage').disabled = state.page >= pages;

  // 标题
  let title = state.search
    ? `搜索「${state.search}」`
    : (state.dir ? (state.dir.split(/[\\/]/).pop() || '全部书籍') : '全部书籍');
  if (state.status) title += ` · ${state.status}`;
  $('listTitle').textContent = `${title}（${state.total} 本）`;
}

async function loadBooks() {
  const r = await api.getBooks({
    dir: state.dir || (state.root || ''),
    status: state.status,
    search: state.search,
    page: state.page,
  });
  state.total = r.total;
  state.books = r.list;
  renderBooks();
}

async function refreshTree() {
  const t = await api.getTree();
  state.root = t.root;
  state.tree = t.tree;
  renderTree();
}

// ---------- 扫描状态 ----------
let refreshBookTimer = null;
function scheduleBooksRefresh() {
  // 扫描期间书名/封面在陆续补齐，节流刷新当前页
  if (refreshBookTimer) return;
  refreshBookTimer = setTimeout(() => { refreshBookTimer = null; loadBooks(); }, 500);
}

function bindScanEvents() {
  api.onScanStatus((s) => {
    const el = $('scanStatus');
    if (!s || !s.msg) { el.hidden = true; return; }
    el.hidden = false;
    el.textContent = s.msg;
    el.classList.toggle('cover', s.phase === 'cover');
    if (s.phase === 'walk' || s.phase === 'listing' || s.phase === 'meta') {
      $('btnRefresh').classList.add('spinning');
    }
    if (s.phase === 'listing') {
      // 目录树 + 占位书名的第一屏已可显示
      state.scanning = true;
      refreshTree();
      loadBooks();
    } else if (s.refresh) {
      scheduleBooksRefresh();
    }
  });
  api.onScanDone(async (r) => {
    state.scanning = false;
    $('btnRefresh').classList.remove('spinning');
    if (r && r.ok) {
      if (r.added || r.updated || r.removed) {
        toast(`扫描完成：新增 ${r.added} · 更新 ${r.updated} · 移除 ${r.removed}`);
      } else {
        toast('扫描完成：没有发现新书');
      }
      await refreshTree();
      await loadBooks();
    } else if (r && r.error) {
      toast(r.error);
    }
    setTimeout(() => { if (!state.scanning) $('scanStatus').hidden = true; }, 2500);
  });
  api.onCoversDone(async () => {
    // 封面生成完成，刷新列表拿到 cover_path
    if (!state.scanning) {
      await loadBooks();
      const el = $('scanStatus');
      if (el.hidden) return;
      if (!el.textContent.startsWith('正在解析')) el.hidden = true;
    }
  });
}

// ---------- 详情弹窗 ----------
async function openDetail(id) {
  const b = await api.getBook(id);
  if (!b) return;
  state.detailId = id;
  const img = $('dCover');
  if (b.cover_path) {
    img.src = api.localUrl(b.cover_path);
    img.style.display = '';
  } else {
    img.removeAttribute('src');
    img.style.display = 'none';
  }
  $('dCoverPh').style.display = b.cover_path ? 'none' : 'flex';
  $('dTitle').textContent = b.title || b.filename;
  $('dAuthor').textContent = b.author ? `作者：${b.author}` : '作者：未知作者';
  const desc = $('dDesc');
  if (b.description) {
    desc.textContent = b.description;
    desc.classList.remove('empty-desc');
  } else {
    desc.textContent = '这本书没有简介信息（元数据未提供），打开后可以直接阅读。';
    desc.classList.add('empty-desc');
  }
  $('dFormat').textContent = (b.ext || '').toUpperCase();
  $('dPath').textContent = b.path;
  const prog = Math.round((b.progress || 0) * 100);
  $('dProgress').textContent = prog > 0 ? `已读 ${prog}%` : '';
  document.querySelectorAll('.st-btn').forEach((btn) => {
    btn.classList.toggle('on', btn.dataset.st === b.status);
  });
  $('modalDetail').hidden = false;
}

function closeDetail() { $('modalDetail').hidden = true; state.detailId = null; }

function bindDetail() {
  $('dClose').addEventListener('click', closeDetail);
  $('modalDetail').addEventListener('click', (e) => { if (e.target === $('modalDetail')) closeDetail(); });
  $('dOpen').addEventListener('click', async () => {
    if (!state.detailId) return;
    const r = await api.openReader(state.detailId);
    if (!r.ok) toast(r.error || '打开失败');
    else closeDetail();
  });
  $('dReveal').addEventListener('click', async () => {
    const b = await api.getBook(state.detailId);
    if (b) api.reveal(b.path);
  });
  $('dMove').addEventListener('click', () => openMove());
  $('dDelete').addEventListener('click', async () => {
    if (!state.detailId) return;
    const b = await api.getBook(state.detailId);
    if (!b) return;
    if (!confirm(`确定删除《${b.title || b.filename}》吗？\n\n将从磁盘永久删除该文件，此操作不可撤销。`)) return;
    const r = await api.deleteBook(state.detailId);
    if (r.ok) {
      toast('已删除');
      closeDetail();
      loadBooks();
    } else {
      toast(r.error || '删除失败');
    }
  });
  document.querySelectorAll('.st-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!state.detailId) return;
      await api.setStatus(state.detailId, btn.dataset.st);
      document.querySelectorAll('.st-btn').forEach((x) => x.classList.toggle('on', x === btn));
      toast(`已标记为「${btn.dataset.st}」`);
      loadBooks();
    });
  });
}

// ---------- 移动到… ----------
async function openMove() {
  const dirs = await api.listDirs();
  const sel = $('moveSel');
  sel.innerHTML = dirs.map((d, i) => `<option value="${esc(d.abs)}" ${i === 0 ? '' : ''}>${esc(d.label)}</option>`).join('');
  const b = await api.getBook(state.detailId);
  $('moveHint').textContent = b ? `当前：${b.dir}` : '';
  $('modalMove').hidden = false;
}

function bindMove() {
  $('moveClose').addEventListener('click', () => { $('modalMove').hidden = true; });
  $('moveBrowse').addEventListener('click', async () => {
    const dir = await api.pickFolder();
    if (dir) $('moveSel').insertAdjacentHTML('beforeend', `<option value="${esc(dir)}" selected>${esc(dir)}（其它文件夹）</option>`);
  });
  $('moveOk').addEventListener('click', async () => {
    const opt = $('moveSel').selectedOptions[0];
    if (!opt) { toast('请先选择目标文件夹'); return; }
    const r = await api.moveBook(state.detailId, opt.value);
    if (!r.ok) { toast(r.error || '移动失败'); return; }
    $('modalMove').hidden = true;
    closeDetail();
    toast('已移动到：' + opt.value);
    await refreshTree();
    await loadBooks();
  });
}

// ---------- 设置 ----------
function bindSettings() {
  $('btnSettings').addEventListener('click', async () => {
    const s = state.settings;
    $('setName').value = s.libraryName;
    $('setDir').value = s.rootDir;
    $('setPerPage').value = s.perPage;
    $('modalSettings').hidden = false;
  });
  $('setClose').addEventListener('click', () => { $('modalSettings').hidden = true; });
  $('btnPickDir').addEventListener('click', async () => {
    const d = await api.pickFolder();
    if (d) $('setDir').value = d;
  });
  $('setSave').addEventListener('click', async () => {
    const s = {
      libraryName: $('setName').value.trim() || '我的图书馆',
      rootDir: $('setDir').value.trim(),
      perPage: parseInt($('setPerPage').value, 10) || 24,
    };
    const r = await api.saveSettings(s);
    state.settings = { ...state.settings, ...s };
    $('libName').textContent = state.settings.libraryName;
    document.title = state.settings.libraryName;
    $('modalSettings').hidden = true;
    toast('设置已保存');
    if (r.rootChanged) startScan();
    else { refreshTree(); loadBooks(); }
  });
}

// ---------- 统计 ----------
function bindStats() {
  $('btnStats').addEventListener('click', async () => {
    const st = await api.getStats();
    $('statsGrid').innerHTML = `
      <div class="stat-cell"><b>${st.total}</b><span>总藏书</span></div>
      <div class="stat-cell"><b>${st.read}</b><span>已读</span></div>
      <div class="stat-cell"><b>${st.reading}</b><span>在读</span></div>
      <div class="stat-cell"><b>${st.unread}</b><span>未读</span></div>
      <div class="stat-cell"><b>${fmtTime(st.weekSeconds)}</b><span>近7天阅读</span></div>
      <div class="stat-cell"><b>${fmtTime(st.totalSeconds)}</b><span>累计阅读</span></div>
      <div class="stat-cell"><b>${st.total ? Math.round(st.read / st.total * 100) : 0}%</b><span>读完比例</span></div>
      <div class="stat-cell"><b>${st.recent.length ? Math.round(st.recent.reduce((a, b) => a + (b.progress || 0), 0) / st.recent.length * 100) : 0}%</b><span>最近均进度</span></div>`;
    $('recentList').innerHTML = st.recent.length
      ? st.recent.map((b) => `<div class="recent-item">
          <span class="t">${esc(b.title)}</span>
          <span class="m">${Math.round((b.progress || 0) * 100)}% · ${fmtTime(b.read_seconds)}</span>
        </div>`).join('')
      : '<div class="form-hint">还没有阅读记录</div>';
    $('modalStats').hidden = false;
  });
  $('statsClose').addEventListener('click', () => { $('modalStats').hidden = true; });
}

// ---------- 扫描 ----------
async function startScan() {
  if (state.scanning) { toast('正在扫描中…'); return; }
  state.scanning = true;
  $('btnRefresh').classList.add('spinning');
  $('scanStatus').hidden = false;
  $('scanStatus').textContent = '准备扫描…';
  const r = await api.runScan();
  if (r && r.error) {
    state.scanning = false;
    $('btnRefresh').classList.remove('spinning');
    $('scanStatus').hidden = true;
    toast(r.error);
  }
}

// ---------- 搜索 / 分页 / 标签 ----------
function bindTopbar() {
  $('btnRefresh').addEventListener('click', startScan);
  $('searchInput').addEventListener('input', (e) => {
    const v = e.target.value.trim();
    $('searchClear').hidden = !v;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.search = v;
      state.page = 1;
      loadBooks();
    }, 350);
  });
  $('searchClear').addEventListener('click', () => {
    $('searchInput').value = '';
    $('searchClear').hidden = true;
    state.search = '';
    state.page = 1;
    loadBooks();
  });
  $('btnRevealRoot').addEventListener('click', () => {
    if (state.settings.rootDir) api.reveal(state.settings.rootDir);
    else toast('尚未设置文件夹');
  });
  $('prevPage').addEventListener('click', () => { if (state.page > 1) { state.page--; loadBooks(); } });
  $('nextPage').addEventListener('click', () => { state.page++; loadBooks(); });
  const jumpToPage = () => {
    const per = state.settings.perPage || 24;
    const pages = Math.max(1, Math.ceil((state.total || 0) / per));
    let n = parseInt($('pageJump').value, 10);
    if (!Number.isFinite(n)) { $('pageJump').value = String(state.page); return; }
    n = Math.min(pages, Math.max(1, n));
    if (n === state.page) { $('pageJump').value = String(n); return; }
    state.page = n;
    loadBooks();
  };
  $('pageJump').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); jumpToPage(); } });
  $('pageJump').addEventListener('blur', jumpToPage);
  $('btnEmptyScan').addEventListener('click', startScan);
  document.querySelectorAll('#tagChips .chip').forEach((c) => {
    c.addEventListener('click', () => {
      document.querySelectorAll('#tagChips .chip').forEach((x) => x.classList.toggle('active', x === c));
      state.status = c.dataset.status || '';
      state.page = 1;
      loadBooks();
    });
  });
}

// ---------- 首次启动引导 ----------
function bindSetup() {
  $('setupPick').addEventListener('click', async () => {
    const d = await api.pickFolder();
    if (d) $('setupDir').value = d;
  });
  $('setupGo').addEventListener('click', async () => {
    const dir = $('setupDir').value.trim();
    if (!dir) { toast('请先选择书籍文件夹'); return; }
    const s = {
      libraryName: $('setupName').value.trim() || '我的图书馆',
      rootDir: dir,
      perPage: 24,
    };
    await api.saveSettings(s);
    state.settings = { ...state.settings, ...s };
    $('libName').textContent = state.settings.libraryName;
    $('setupOverlay').hidden = true;
    refreshTree();
    startScan();
  });
}

// ---------- 启动 ----------
async function boot() {
  state.settings = await api.getSettings();
  $('libName').textContent = state.settings.libraryName;
  document.title = state.settings.libraryName;

  bindScanEvents();
  bindDetail();
  bindMove();
  bindSettings();
  bindStats();
  bindSetup();
  bindTopbar();

  if (!state.settings.rootDir) {
    $('setupOverlay').hidden = false;
    return;
  }
  await refreshTree();
  await loadBooks();
}
boot();
