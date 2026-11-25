'use strict';

/**
 * 共享数字图书库 —— 零依赖后端
 *
 * 运行： node server.js    然后打开 http://localhost:3000
 *
 * 设计要点：
 *  1. 单一共享数据源：所有窗口读写同一份数据，所以是"共享"书目
 *  2. 版本号乐观锁：借 / 还 / 编辑都携带客户端看到的 version
 *     - 冲突时返回 409 和记录的最新副本，客户端可以用新版本自动重试一次
 *     - 借书冲突重试后：库存够就成功，库存没了就进预约队列（业务结果不同，但不会写坏数据）
 *     - 编辑冲突不重试：必须让人重新看一遍，避免覆盖别人的修改
 *  3. 库存为 0 时排队，归还时按 FIFO 预留给队首
 *  4. 数据落盘到 data.json，重启不丢
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DB_FILE = path.join(__dirname, 'data.json');
const MAX_LOGS = 60;

let books = [];
let reservations = [];   // FIFO: { bookId, member }
let logs = [];
let nextBookId = 1;

const stamp = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });

function addLog(msg, type = 'info') {
  logs.unshift({ time: stamp(), msg, type });
  if (logs.length > MAX_LOGS) logs.length = MAX_LOGS;
}

/* ---------------- 存储 ---------------- */

function save() {
  try {
    fs.writeFileSync(
      DB_FILE,
      JSON.stringify({ books, reservations, nextBookId }, null, 2),
      'utf8'
    );
  } catch (err) {
    console.error('保存失败：', err.message);
  }
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (Array.isArray(raw.books) && raw.books.length) {
      books = raw.books.map((b) => ({ ...b, borrowers: b.borrowers || [] }));
      reservations = raw.reservations || [];
      nextBookId = raw.nextBookId || books.length + 1;
      addLog('已载入本地数据', 'info');
      return true;
    }
  } catch { /* 没有数据文件，走初始化 */ }
  return false;
}

function seed() {
  nextBookId = 1;
  books = [
    { id: nextBookId++, title: 'Clean Code', author: 'Robert C. Martin', copies: 3, borrowers: [], version: 1, reservedFor: null, note: '2 楼书架 A-3' },
    { id: nextBookId++, title: '人月神话', author: 'Frederick P. Brooks', copies: 1, borrowers: [], version: 1, reservedFor: null, note: '' },
    { id: nextBookId++, title: '设计模式', author: 'GoF', copies: 2, borrowers: [{ member: '王五' }, { member: '赵六' }], version: 1, reservedFor: null, note: '' },
  ];
  reservations = [];
  logs = [];
  syncAll();
  addLog('系统初始化：3 本图书', 'info');
  save();
}

/** 可用库存永远由「总副本 - 已借出 - 已预留」推导，避免两个字段写歪 */
function syncAvailable(b) {
  b.available = b.copies - b.borrowers.length - (b.reservedFor ? 1 : 0);
}
function syncAll() {
  books.forEach(syncAvailable);
}

const findBook = (id) => books.find((b) => b.id === id);
const queueOf = (bookId) => reservations.filter((r) => r.bookId === bookId);

function conflict(b, version, hint) {
  return {
    status: 409,
    payload: {
      ok: false,
      code: 'CONFLICT',
      message: `版本冲突：你提交的是 v${version}，当前已是 v${b.version}。${hint}`,
      // 附带最新记录，客户端可以用新版本重试，不必先刷新整页
      book: { id: b.id, version: b.version, available: b.available, copies: b.copies },
    },
  };
}

/* ---------------- 借书 ---------------- */

function borrow(bookId, member, version) {
  const b = findBook(bookId);
  if (!b) return { status: 404, payload: { ok: false, message: '图书不存在' } };

  // ① 乐观锁：版本必须与客户端看到的一致
  if (b.version !== version) return conflict(b, version, '请重试。');

  // ② 别人预留的书不能抢
  if (b.reservedFor && b.reservedFor !== member) {
    return { status: 409, payload: { ok: false, code: 'RESERVED', message: `这本书已预留给 ${b.reservedFor}` } };
  }

  // ③ 被预留者取走自己那份
  if (b.reservedFor === member) {
    b.reservedFor = null;
    b.borrowers.push({ member });
    b.version += 1;
    syncAvailable(b);
    save();
    addLog(`${member} 取走预留的《${b.title}》`, 'ok');
    return { status: 200, payload: { ok: true, message: '已取走为你预留的副本', book: publicBook(b) } };
  }

  // ④ 有库存：扣减 + 版本 +1（同一同步块内完成，不会交错）
  if (b.available > 0) {
    b.borrowers.push({ member });
    b.version += 1;
    syncAvailable(b);
    save();
    addLog(`${member} 借出《${b.title}》，可借 ${b.available}/${b.copies}`, 'ok');
    return { status: 200, payload: { ok: true, message: `借书成功，剩余 ${b.available} 本`, book: publicBook(b) } };
  }

  // ⑤ 没库存：进预约队列（同一人只排一次）
  if (queueOf(bookId).some((r) => r.member === member)) {
    return { status: 200, payload: { ok: true, message: '你已经在预约队列中', book: publicBook(b) } };
  }
  reservations.push({ bookId, member });
  save();
  addLog(`${member} 预约《${b.title}》，排在第 ${queueOf(bookId).length} 位`, 'warn');
  return {
    status: 200,
    payload: { ok: true, message: `库存为 0，已加入预约队列（第 ${queueOf(bookId).length} 位）`, book: publicBook(b) },
  };
}

/* ---------------- 还书 ---------------- */

function giveBack(bookId, member, version) {
  const b = findBook(bookId);
  if (!b) return { status: 404, payload: { ok: false, message: '图书不存在' } };

  if (b.version !== version) return conflict(b, version, '请重试。');

  if (b.borrowers.length === 0) {
    return { status: 400, payload: { ok: false, message: '这本书当前没有借出记录' } };
  }

  // 优先归还自己借的那本，否则任意一本
  const i = b.borrowers.findIndex((x) => x.member === member);
  if (i >= 0) b.borrowers.splice(i, 1);
  else b.borrowers.pop();

  // 有人排队 → 收回的这本直接预留给队首，不重新上架
  const q = reservations.findIndex((r) => r.bookId === bookId);
  if (q >= 0) {
    const next = reservations.splice(q, 1)[0];
    b.reservedFor = next.member;
    b.version += 1;
    syncAvailable(b);
    save();
    addLog(`《${b.title}》已归还，按队列预留给 ${next.member}`, 'ok');
    return { status: 200, payload: { ok: true, message: `已归还，按队列预留给 ${next.member}`, book: publicBook(b) } };
  }

  b.version += 1;
  syncAvailable(b);
  save();
  addLog(`${member} 归还《${b.title}》，可借 ${b.available}/${b.copies}`, 'ok');
  return { status: 200, payload: { ok: true, message: `归还成功，可借 ${b.available} 本`, book: publicBook(b) } };
}

/* ---------------- 编辑图书（BL-4 冲突检测 / BL-8 备注） ---------------- */

function editBook(bookId, body) {
  const b = findBook(bookId);
  if (!b) return { status: 404, payload: { ok: false, message: '图书不存在' } };

  const version = Number(body.version);
  // 编辑不自动重试：必须让人重新确认，否则就是"后写覆盖前写"
  if (b.version !== version) return conflict(b, version, '请刷新后重新编辑。');

  const title = String(body.title ?? b.title).trim();
  const author = String(body.author ?? b.author).trim();
  const copies = Number(body.copies ?? b.copies);
  const note = String(body.note ?? b.note ?? '').trim().slice(0, 80);
  const member = String(body.member || '').trim() || '匿名';

  if (!title || !author) return { status: 400, payload: { ok: false, message: '书名和作者不能为空' } };
  if (!Number.isInteger(copies) || copies < 1 || copies > 99) {
    return { status: 400, payload: { ok: false, message: '副本数必须是 1-99 的整数' } };
  }

  const out = b.borrowers.length + (b.reservedFor ? 1 : 0);
  if (copies < out) {
    return { status: 400, payload: { ok: false, message: `副本数不能少于已借出数量（当前借出 ${out} 本）` } };
  }

  const before = { title: b.title, copies: b.copies, note: b.note || '' };
  b.title = title;
  b.author = author;
  b.copies = copies;
  b.note = note;
  b.version += 1;
  syncAvailable(b);
  save();

  const changes = [];
  if (before.title !== b.title) changes.push('书名');
  if (before.copies !== b.copies) changes.push(`副本 ${before.copies}→${b.copies}`);
  if (before.note !== b.note) changes.push('备注');
  addLog(
    `${member} 编辑《${b.title}》${changes.length ? '：' + changes.join('，') : '（无字段变化）'}，版本 v${b.version}`,
    'ok'
  );
  return { status: 200, payload: { ok: true, message: `保存成功，当前版本 v${b.version}`, book: publicBook(b) } };
}

/* ---------------- 新增图书 ---------------- */

function addBook(title, author, copies) {
  const n = Number(copies);
  if (!title || !author) return { status: 400, payload: { ok: false, message: '书名和作者不能为空' } };
  if (!Number.isInteger(n) || n < 1 || n > 99) {
    return { status: 400, payload: { ok: false, message: '副本数必须是 1-99 的整数' } };
  }
  const b = {
    id: nextBookId++, title, author, copies: n,
    borrowers: [], version: 1, reservedFor: null, note: '',
  };
  syncAvailable(b);
  books.push(b);
  save();
  addLog(`${title} 上架，共 ${n} 本`, 'info');
  return { status: 201, payload: { ok: true, message: '新增成功', book: publicBook(b) } };
}

function publicBook(b) {
  return { ...b, queueCount: queueOf(b.id).length };
}

/* ---------------- HTTP 工具 ---------------- */

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

/* ---------------- 路由 ---------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  try {
    if (p === '/api/state' && req.method === 'GET') {
      return sendJson(res, 200, { books: books.map(publicBook), reservations, logs });
    }

    if (p === '/api/reset' && req.method === 'POST') {
      seed();
      return sendJson(res, 200, { ok: true, message: '已恢复示例数据' });
    }

    if (p === '/api/log' && req.method === 'POST') {
      const body = await readBody(req);
      addLog(String(body.msg || ''), String(body.type || 'info'));
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/books' && req.method === 'POST') {
      const body = await readBody(req);
      const r = addBook(String(body.title || '').trim(), String(body.author || '').trim(), body.copies);
      return sendJson(res, r.status, r.payload);
    }

    const pm = p.match(/^\/api\/books\/(\d+)$/);
    if (pm && req.method === 'PATCH') {
      const body = await readBody(req);
      const r = editBook(Number(pm[1]), body);
      return sendJson(res, r.status, r.payload);
    }

    const m = p.match(/^\/api\/books\/(\d+)\/(borrow|return)$/);
    if (m && req.method === 'POST') {
      const body = await readBody(req);
      const id = Number(m[1]);
      const member = String(body.member || '').trim() || '匿名';
      const version = Number(body.version);
      if (!Number.isFinite(version)) {
        return sendJson(res, 400, { ok: false, message: '缺少 version 参数' });
      }
      const r = m[2] === 'borrow' ? borrow(id, member, version) : giveBack(id, member, version);
      return sendJson(res, r.status, r.payload);
    }

    serveStatic(p, res);
  } catch (err) {
    sendJson(res, 500, { ok: false, message: '服务器错误：' + err.message });
  }
});

if (!load()) seed();

server.listen(PORT, () => {
  console.log(`\n  📚 共享数字图书库已启动`);
  console.log(`  → http://localhost:${PORT}\n`);
});
