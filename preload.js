// 预加载：向渲染进程暴露安全 API
const { contextBridge, ipcRenderer } = require('electron');
const path = require('path');

function on(channel, cb) {
  const fn = (e, args) => cb(args);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
}

function localUrl(p) {
  if (!p) return '';
  return 'elocal://f/' + String(p).replace(/\\/g, '/').replace(/^\//, '');
}

const assets = {
  jszip: localUrl(path.join(__dirname, 'node_modules', 'jszip', 'dist', 'jszip.min.js')),
  pdfjs: localUrl(path.join(__dirname, 'node_modules', 'pdfjs-dist', 'build', 'pdf.js')),
  pdfWorker: localUrl(path.join(__dirname, 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.min.js')),
  pdfCmaps: localUrl(path.join(__dirname, 'node_modules', 'pdfjs-dist', 'cmaps')) + '/',
  pdfFonts: localUrl(path.join(__dirname, 'node_modules', 'pdfjs-dist', 'standard_fonts')) + '/',
  epubjs: localUrl(path.join(__dirname, 'node_modules', 'epubjs', 'dist', 'epub.min.js')),
};

contextBridge.exposeInMainWorld('api', {
  assets,

  // 设置
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  pickFolder: () => ipcRenderer.invoke('dialog:pick'),

  // 扫描
  runScan: () => ipcRenderer.invoke('scan:run'),
  onScanStatus: (cb) => on('scan:status', cb),
  onScanDone: (cb) => on('scan:done', cb),
  onCoversDone: (cb) => on('covers:done', cb),

  // 数据
  getTree: () => ipcRenderer.invoke('tree:get'),
  getBooks: (args) => ipcRenderer.invoke('books:list', args),
  getBook: (id) => ipcRenderer.invoke('books:get', id),
  moveBook: (id, targetDir) => ipcRenderer.invoke('books:move', { id, targetDir }),
  deleteBook: (id) => ipcRenderer.invoke('books:delete', id),
  setStatus: (id, status) => ipcRenderer.invoke('books:status', { id, status }),
  saveProgress: (id, progress, location, status) => ipcRenderer.invoke('books:progress', { id, progress, location, status }),
  addSeconds: (id, seconds) => ipcRenderer.invoke('books:seconds', { id, seconds }),
  getStats: () => ipcRenderer.invoke('stats:get'),
  listDirs: () => ipcRenderer.invoke('dirs:list'),
  reveal: (p) => ipcRenderer.invoke('shell:reveal', p),

  // 书签
  listBookmarks: (bookId) => ipcRenderer.invoke('bookmarks:list', bookId),
  addBookmark: (bookId, location, label) => ipcRenderer.invoke('bookmarks:add', { bookId, location, label }),
  removeBookmark: (id) => ipcRenderer.invoke('bookmarks:remove', id),

  // 阅读器
  openReader: (id) => ipcRenderer.invoke('reader:open', id),
  readerLoad: (id) => ipcRenderer.invoke('reader:load', id),

  // 快照窗口回传
  snapshotReply: (payload) => ipcRenderer.send('__snapshot', payload),
  onSnapshotRender: (cb) => {
    const fn = (e, args) => cb(args);
    ipcRenderer.on('snapshot:render', fn);
    return () => ipcRenderer.removeListener('snapshot:render', fn);
  },

  localUrl,
});
