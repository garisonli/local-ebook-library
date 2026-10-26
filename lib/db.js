// 本地索引数据库（sql.js / SQLite，持久化到 userData/library-index.db）
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

let SQL = null, db = null, dbPath = '', saveTimer = null;

async function init(userDataDir) {
  SQL = await initSqlJs();
  dbPath = path.join(userDataDir, 'library-index.db');
  if (fs.existsSync(dbPath)) {
    try { db = new SQL.Database(fs.readFileSync(dbPath)); }
    catch (e) { db = new SQL.Database(); }
  } else {
    db = new SQL.Database();
  }
  db.run(`CREATE TABLE IF NOT EXISTS books (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT UNIQUE NOT NULL,
    dir TEXT,
    filename TEXT,
    ext TEXT,
    title TEXT,
    author TEXT,
    description TEXT,
    cover_path TEXT,
    cover_state INTEGER DEFAULT 0,
    file_size INTEGER,
    mtime INTEGER,
    added_at INTEGER,
    last_read INTEGER DEFAULT 0,
    progress REAL DEFAULT 0,
    location TEXT,
    status TEXT DEFAULT '未读',
    read_seconds INTEGER DEFAULT 0
  );`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_books_dir ON books(dir);`);
  db.run(`CREATE TABLE IF NOT EXISTS bookmarks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER,
    location TEXT,
    label TEXT,
    created_at INTEGER
  );`);
  persist();
}

function persist() {
  try { if (db) fs.writeFileSync(dbPath, Buffer.from(db.export())); } catch (e) { /* 忽略 */ }
}
function schedulePersist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; persist(); }, 1500);
}

function rows(sql, params) {
  const st = db.prepare(sql);
  st.bind(params || []);
  const out = [];
  while (st.step()) out.push(st.getAsObject());
  st.free();
  return out;
}
function one(sql, params) { return rows(sql, params)[0] || null; }

// ---------- 书目 ----------
function getByPath(p) { return one('SELECT * FROM books WHERE path = ?', [p]); }
function getById(id) { return one('SELECT * FROM books WHERE id = ?', [id]); }

function insertBook(b) {
  db.run(`INSERT INTO books (path, dir, filename, ext, title, author, description, cover_path, cover_state, file_size, mtime, added_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [b.path, b.dir, b.filename, b.ext, b.title || '', b.author || '', b.description || '',
     b.cover_path || null, b.cover_state || 0, b.file_size, b.mtime, Date.now()]);
  schedulePersist();
  return one('SELECT id FROM books WHERE path = ?', [b.path]).id;
}

function updateExtract(id, b) {
  db.run(`UPDATE books SET title=?, author=?, description=?, cover_path=?, cover_state=?, file_size=?, mtime=? WHERE id=?`,
    [b.title || '', b.author || '', b.description || '', b.cover_path || null, b.cover_state || 0,
     b.file_size, b.mtime, id]);
  schedulePersist();
}
function setCover(id, coverPath, coverState) {
  db.run('UPDATE books SET cover_path=?, cover_state=? WHERE id=?', [coverPath, coverState, id]);
  schedulePersist();
}
function removeByPath(p) { db.run('DELETE FROM books WHERE path=?', [p]); schedulePersist(); }

// 「移动到…」后更新路径（保留阅读进度、状态、书签）
function updatePath(id, newPath, newDir, newFilename) {
  db.run('UPDATE books SET path=?, dir=?, filename=? WHERE id=?', [newPath, newDir, newFilename, id]);
  schedulePersist();
}

function allPaths() {
  return rows('SELECT id, path, file_size, mtime FROM books').reduce((m, r) => { m[r.path] = r; return m; }, {});
}

// 目录过滤（含子目录）+ 状态 + 搜索 + 分页
function listBooks({ dir, dirRoot, status, search, page = 1, perPage = 24 }) {
  const where = [], params = [];
  if (dir && dirRoot && path.resolve(dir) !== path.resolve(dirRoot)) {
    const like = dir.replace(/[\\]/g, '\\\\') ; // 简单处理，实际用 length+substr 更稳
    where.push(`(dir = ? OR dir LIKE ?)`);
    params.push(dir, dir.replace(/[\\/]+$/, '') + (dir.includes('/') ? '/' : '\\') + '%');
    // 统一分隔符：dir 存储与查询均使用原生分隔符
  }
  if (status && status !== '全部') { where.push('status = ?'); params.push(status); }
  if (search) { where.push('(title LIKE ? OR author LIKE ? OR filename LIKE ?)'); const s = '%' + search + '%'; params.push(s, s, s); }
  const wsql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const total = one('SELECT COUNT(*) AS c FROM books' + wsql, params).c;
  const order = ' ORDER BY (last_read > 0) DESC, last_read DESC, title ASC';
  const offset = (Math.max(1, page) - 1) * perPage;
  const list = rows('SELECT * FROM books' + wsql + order + ' LIMIT ? OFFSET ?', params.concat([perPage, offset]));
  return { total, list };
}

function folderCount(dir, dirRoot) {
  if (path.resolve(dir) === path.resolve(dirRoot)) return one('SELECT COUNT(*) AS c FROM books').c;
  const sep = dir.includes('/') ? '/' : '\\';
  const prefix = dir.replace(/[\\/]+$/, '') + sep;
  const r = one('SELECT COUNT(*) AS c FROM books WHERE dir = ? OR dir LIKE ?', [dir, prefix + '%']);
  return r.c;
}

function distinctDirs() {
  return rows('SELECT DISTINCT dir FROM books').map(r => r.dir);
}
function allBooks(whereSql, params) {
  return rows('SELECT * FROM books' + (whereSql ? ` WHERE ${whereSql}` : ''), params || []);
}

function searchBooks(q, limit = 100) {
  const s = '%' + q + '%';
  return rows(`SELECT * FROM books WHERE title LIKE ? OR author LIKE ? OR filename LIKE ?
               ORDER BY (last_read > 0) DESC, title ASC LIMIT ?`, [s, s, s, limit]);
}

// ---------- 阅读进度 / 状态 ----------
function updateProgress(id, { progress, location, status }) {
  const b = getById(id); if (!b) return;
  let st = status;
  if (!st) {
    if (progress >= 0.95) st = b.status === '已读' ? '已读' : '已读';
    else if (progress > 0.01) st = '在读';
    else st = b.status;
  }
  // location 传 null 表示不改；传空串/空格表示清空（不能用 || null，否则永远清不掉）
  const locArg = (location === null || location === undefined) ? null : String(location);
  db.run('UPDATE books SET progress=?, location=?, status=?, last_read=? WHERE id=?',
    [progress || 0, locArg === null ? (b.location || '') : locArg, st || '未读', Date.now(), id]);
  schedulePersist();
}
function setStatus(id, status) {
  db.run('UPDATE books SET status=? WHERE id=?', [status, id]); schedulePersist();
}
function addReadSeconds(id, sec) {
  if (!sec || sec <= 0) return;
  db.run('UPDATE books SET read_seconds = read_seconds + ? WHERE id=?', [Math.round(sec), id]);
  schedulePersist();
}
function touchRead(id) {
  db.run('UPDATE books SET last_read=? WHERE id=?', [Date.now(), id]); schedulePersist();
}

// ---------- 书签 ----------
function addBookmark(bookId, location, label) {
  db.run('INSERT INTO bookmarks (book_id, location, label, created_at) VALUES (?,?,?,?)',
    [bookId, location, label || '', Date.now()]);
  schedulePersist();
  return one('SELECT * FROM bookmarks WHERE id = last_insert_rowid()');
}
function listBookmarks(bookId) {
  return rows('SELECT * FROM bookmarks WHERE book_id=? ORDER BY created_at DESC', [bookId]);
}
function removeBookmark(id) { db.run('DELETE FROM bookmarks WHERE id=?', [id]); schedulePersist(); }

// ---------- 统计 ----------
function stats() {
  const total = one('SELECT COUNT(*) c FROM books').c;
  const read = one(`SELECT COUNT(*) c FROM books WHERE status='已读'`).c;
  const reading = one(`SELECT COUNT(*) c FROM books WHERE status='在读'`).c;
  const unread = total - read - reading;
  const weekAgo = Date.now() - 7 * 86400000;
  const weekSeconds = one('SELECT COALESCE(SUM(read_seconds),0) s FROM books WHERE last_read >= ?', [weekAgo]).s;
  const totalSeconds = one('SELECT COALESCE(SUM(read_seconds),0) s FROM books').s;
  const recent = rows('SELECT * FROM books WHERE last_read > 0 ORDER BY last_read DESC LIMIT 8');
  return { total, read, reading, unread, weekSeconds, totalSeconds, recent };
}

module.exports = {
  init, persist, schedulePersist,
  getByPath, getById, insertBook, updateExtract, setCover, removeByPath, updatePath, allPaths, allBooks,
  listBooks, folderCount, distinctDirs, searchBooks,
  updateProgress, setStatus, addReadSeconds, touchRead,
  addBookmark, listBookmarks, removeBookmark,
  stats
};
