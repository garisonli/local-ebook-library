// 实验：elocal 协议 fetch 是否可用（独立 Electron 进程）
const { app, protocol, net, session, BrowserWindow } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

protocol.registerSchemesAsPrivileged([
  { scheme: 'elocal', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

function elocalUrl(p) {
  return 'elocal://f/' + String(p).replace(/\\/g, '/').replace(/^\//, '');
}

app.whenReady().then(() => {
  session.defaultSession.protocol.handle('elocal', async (req) => {
    try {
      const u = new URL(req.url);
      let p = decodeURIComponent(u.pathname.slice(1));
      if (!/^[A-Za-z]:[\\/]/.test(p)) p = '/' + p;
      if (!require('fs').existsSync(p)) return new Response('Not Found:' + p, { status: 404 });
      return net.fetch(pathToFileURL(p).toString());
    } catch (e) {
      return new Response('ERR ' + e.message, { status: 500 });
    }
  });

  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: false } });
  win.webContents.on('console-message', (e, level, message) => {
    console.log('[page]', message);
  });
  win.webContents.once('did-finish-load', () => {
    setTimeout(() => app.quit(), 5000);
  });
  win.loadFile(path.join(__dirname, 'elocal-test.html'));
});

app.on('window-all-closed', () => app.quit());
