'use strict';

/**
 * Shared Digital Book Library — zero-dependency backend
 *
 * Run: node server.js, then open http://localhost:3000
 *
 * Pages:
 *   /                 catalogue (borrow / return, search, tag filter)
 *   /book.html?id=1   book detail (stock, queue, history, ratings)
 *   /me.html          my loans (on loan, queue, my reviews)
 *   /stats.html       dashboard (stock, utilisation, ranking, tags)
 *
 * Design notes:
 *  1. One shared data source: every window reads and writes the same records, which is what makes the catalogue "shared".
 *  2. Version-based optimistic locking: borrow / return / edit all send the version the client last saw.
 *     - On conflict the API returns 409 plus the current record, so the client can retry once with the fresh version.
 *     - A retried borrow either succeeds (stock left) or queues the member (out of stock); the data never goes wrong.
 *     - An edit is never retried: a human must re-read the record, otherwise one change silently overwrites the other.
 *  3. Borrowing at zero stock joins a FIFO queue; a return is held for the member at the head of the queue.
 *  4. Every book keeps an append-only history and one rating per member.
 *  5. State is persisted to data.json, so a restart loses nothing.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DB_FILE = path.join(__dirname, 'data.json');
const MAX_LOGS = 60;
const MAX_HISTORY = 40;

let books = [];
let reservations = [];   // FIFO: { bookId, member }
let logs = [];
let nextBookId = 1;

const pad = (n) => String(n).padStart(2, '0');

/** Log time: 14:05:09 */
const stamp = () => {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

/** History / loan time: 11-26 14:05 (with the date, so old entries stay readable) */
const stampDate = (d = new Date()) =>
  `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

function addLog(msg, type = 'info') {
  logs.unshift({ time: stamp(), msg, type });
  if (logs.length > MAX_LOGS) logs.length = MAX_LOGS;
}

/** Per-book history: added / borrowed / returned / edited — append only */
function addHistory(b, type, member, detail) {
  b.history.unshift({ time: stampDate(), type, member: member || '', detail: detail || '' });
  if (b.history.length > MAX_HISTORY) b.history.length = MAX_HISTORY;
}

/* ---------------- storage ---------------- */

function save() {
  try {
    fs.writeFileSync(
      DB_FILE,
      JSON.stringify({ books, reservations, nextBookId }, null, 2),
      'utf8'
    );
  } catch (err) {
    console.error('Save failed:', err.message);
  }
}

/** Backfill old data so an upgrade never leaves a blank page */
function normalizeBook(b) {
  return {
    id: Number(b.id),
    title: String(b.title || ''),
    author: String(b.author || ''),
    copies: Number(b.copies) || 1,
    borrowers: (b.borrowers || []).map((x) =>
      typeof x === 'string' ? { member: x, since: '' } : { member: x.member, since: x.since || '' }
    ),
    version: Number(b.version) || 1,
    reservedFor: b.reservedFor || null,
    note: b.note || '',
    tags: Array.isArray(b.tags) ? b.tags : [],
    history: Array.isArray(b.history) ? b.history : [],
    reviews: Array.isArray(b.reviews) ? b.reviews : [],
  };
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (Array.isArray(raw.books) && raw.books.length) {
      books = raw.books.map(normalizeBook);
      reservations = raw.reservations || [];
      nextBookId = raw.nextBookId || books.length + 1;
      syncAll();
      addLog('Loaded saved data from data.json', 'info');
      return true;
    }
  } catch { /* no data file yet — seed instead */ }
  return false;
}

function seed() {
  nextBookId = 1;
  books = [
    {
      id: nextBookId++, title: 'Clean Code', author: 'Robert C. Martin', copies: 3,
      borrowers: [{ member: 'Alice', since: '11-24 18:20' }, { member: 'Ben', since: '11-25 09:41' }],
      version: 3, reservedFor: null, note: '2F, shelf A-3', tags: ['software design', 'Java'],
      history: [
        { time: '11-25 09:41', type: 'borrow', member: 'Ben', detail: '1 copy' },
        { time: '11-24 18:20', type: 'borrow', member: 'Alice', detail: '1 copy' },
        { time: '11-24 16:02', type: 'edit', member: 'Alice', detail: 'note' },
        { time: '11-24 15:48', type: 'add', member: 'Alice', detail: '3 copies' },
      ],
      reviews: [
        { member: 'Ben', rating: 5, comment: 'Naming chapter alone is worth re-reading; I rewrote my code the same week.', time: '11-25 10:02' },
        { member: 'Chloe', rating: 4, comment: 'The later case studies are dated, but the principles still hold.', time: '11-23 21:15' },
      ],
    },
    {
      id: nextBookId++, title: 'The Mythical Man-Month', author: 'Frederick P. Brooks', copies: 1,
      borrowers: [], version: 7, reservedFor: null, note: '', tags: ['project management', 'classic'],
      history: [
        { time: '11-25 17:30', type: 'return', member: 'Dan', detail: '1 copy, 1 available' },
        { time: '11-22 14:10', type: 'borrow', member: 'Dan', detail: '1 copy' },
        { time: '11-20 11:05', type: 'add', member: 'Ben', detail: '1 copy' },
      ],
      reviews: [
        { member: 'Dan', rating: 5, comment: 'Written in 1975, yet "adding people slows you down" still happens today.', time: '11-22 20:12' },
      ],
    },
    {
      id: nextBookId++, title: 'Design Patterns', author: 'GoF', copies: 2,
      borrowers: [{ member: 'Chloe', since: '11-23 15:10' }, { member: 'Dan', since: '11-25 13:02' }],
      version: 1, reservedFor: null, note: '', tags: ['software design', 'OOP'],
      history: [
        { time: '11-25 13:02', type: 'borrow', member: 'Dan', detail: '1 copy' },
        { time: '11-23 15:10', type: 'borrow', member: 'Chloe', detail: '1 copy' },
        { time: '11-21 09:30', type: 'add', member: 'Chloe', detail: '2 copies' },
      ],
      reviews: [
        { member: 'Ben', rating: 4, comment: 'Use it as a dictionary, not as a book to read end to end.', time: '11-24 22:40' },
      ],
    },
    {
      id: nextBookId++, title: 'Code Complete', author: 'Steve McConnell', copies: 2,
      borrowers: [], version: 2, reservedFor: null, note: '3F, shelf B-2', tags: ['software engineering', 'classic'],
      history: [
        { time: '11-24 09:12', type: 'edit', member: 'Alice', detail: 'note' },
        { time: '11-19 15:20', type: 'add', member: 'Alice', detail: '2 copies' },
      ],
      reviews: [
        { member: 'Alice', rating: 5, comment: 'The reference of references; I look things up far more than I read it.', time: '11-24 09:30' },
      ],
    },
    {
      id: nextBookId++, title: 'Peopleware', author: 'Tom DeMarco', copies: 1,
      borrowers: [], version: 4, reservedFor: 'Dan', note: '', tags: ['project management'],
      history: [
        { time: '11-26 10:05', type: 'return', member: 'Ben', detail: 'held for Dan by queue order' },
        { time: '11-21 13:40', type: 'borrow', member: 'Ben', detail: '1 copy' },
        { time: '11-18 10:15', type: 'add', member: 'Ben', detail: '1 copy' },
      ],
      reviews: [],
    },
    {
      id: nextBookId++, title: 'Computer Systems', author: 'Randal E. Bryant', copies: 1,
      borrowers: [{ member: 'Chloe', since: '11-26 09:10' }],
      version: 2, reservedFor: null, note: '3F, shelf C-1', tags: ['computer systems'],
      history: [
        { time: '11-26 09:10', type: 'borrow', member: 'Chloe', detail: 'Borrowed 1 copy, 0 left' },
        { time: '11-18 10:12', type: 'add', member: 'Chloe', detail: '1 copy' },
      ],
      reviews: [],
    },
  ];
  reservations = [];
  logs = [];
  syncAll();
  addLog('Initialised with 6 sample books', 'info');
  save();
}

/** available is always derived from copies - on loan - held, so the two numbers can never drift apart */
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
      message: `Version conflict: you sent v${version}, the record is already at v${b.version}. ${hint}`,
      // include the current record so the client can retry without a full page refresh
      book: { id: b.id, version: b.version, available: b.available, copies: b.copies },
    },
  };
}

/** Ratings: one per member, averaged */
function ratingOf(b) {
  if (!b.reviews || !b.reviews.length) return { avgRating: 0, reviewCount: 0 };
  const sum = b.reviews.reduce((n, r) => n + Number(r.rating || 0), 0);
  return {
    avgRating: Math.round((sum / b.reviews.length) * 10) / 10,
    reviewCount: b.reviews.length,
  };
}

/* ---------------- borrow ---------------- */

function borrow(bookId, member, version) {
  const b = findBook(bookId);
  if (!b) return { status: 404, payload: { ok: false, message: 'Book not found' } };

  // (1) optimistic lock: the version must match the one the client saw
  if (b.version !== version) return conflict(b, version, 'Please try again.');

  // (2) a copy held for somebody else cannot be taken
  if (b.reservedFor && b.reservedFor !== member) {
    return { status: 409, payload: { ok: false, code: 'RESERVED', message: `This copy is reserved for ${b.reservedFor}` } };
  }

  // (3) the reserved member collects their copy
  if (b.reservedFor === member) {
    b.reservedFor = null;
    b.borrowers.push({ member, since: stampDate() });
    b.version += 1;
    syncAvailable(b);
    addHistory(b, 'borrow', member, 'reserved copy');
    save();
    addLog(`${member} collected the copy of "${b.title}" reserved for them`, 'ok');
    return { status: 200, payload: { ok: true, message: 'Collected the copy reserved for you', book: publicBook(b) } };
  }

  // (4) stock left: decrement and bump the version inside one synchronous block, so nothing interleaves
  if (b.available > 0) {
    b.borrowers.push({ member, since: stampDate() });
    b.version += 1;
    syncAvailable(b);
    addHistory(b, 'borrow', member, `${b.available} left`);
    save();
    addLog(`${member} borrowed "${b.title}" — ${b.available}/${b.copies} available`, 'ok');
    return { status: 200, payload: { ok: true, message: `Borrowed successfully — ${b.available} left`, book: publicBook(b) } };
  }

  // (5) no stock: join the queue (each member is queued once)
  if (queueOf(bookId).some((r) => r.member === member)) {
    return { status: 200, payload: { ok: true, message: 'You are already in the reservation queue', book: publicBook(b) } };
  }
  reservations.push({ bookId, member });
  save();
  addLog(`${member} reserved "${b.title}" — position ${queueOf(bookId).length} in the queue`, 'warn');
  return {
    status: 200,
    payload: {
      ok: true,
      code: 'OUT_OF_STOCK',
      message: `Out of stock — added to the reservation queue (position ${queueOf(bookId).length})`,
      book: publicBook(b),
    },
  };
}

/* ---------------- return ---------------- */

function giveBack(bookId, member, version) {
  const b = findBook(bookId);
  if (!b) return { status: 404, payload: { ok: false, message: 'Book not found' } };

  if (b.version !== version) return conflict(b, version, 'Please try again.');

  if (b.borrowers.length === 0) {
    return { status: 400, payload: { ok: false, message: 'This book has no copies on loan' } };
  }

  // return the member's own copy when there is one, otherwise any copy
  const i = b.borrowers.findIndex((x) => x.member === member);
  if (i >= 0) b.borrowers.splice(i, 1);
  else b.borrowers.pop();

  // somebody is queued → the returned copy is held for the head of the queue instead of going back on the shelf
  const q = reservations.findIndex((r) => r.bookId === bookId);
  if (q >= 0) {
    const next = reservations.splice(q, 1)[0];
    b.reservedFor = next.member;
    b.version += 1;
    syncAvailable(b);
    addHistory(b, 'return', member, `held for ${next.member} by queue order`);
    save();
    addLog(`"${b.title}" returned — held for ${next.member} by queue order`, 'ok');
    return { status: 200, payload: { ok: true, message: `Returned — held for ${next.member} by queue order`, book: publicBook(b) } };
  }

  b.version += 1;
  syncAvailable(b);
  addHistory(b, 'return', member, `${b.available} available`);
  save();
  addLog(`${member} returned "${b.title}" — ${b.available}/${b.copies} available`, 'ok');
  return { status: 200, payload: { ok: true, message: `Returned successfully — ${b.available} available`, book: publicBook(b) } };
}

/* ---------------- edit book (BL-4 conflict detection / BL-8 note / tags) ---------------- */

function cleanTags(input) {
  if (input === undefined) return null;
  const arr = Array.isArray(input) ? input : String(input).split(/[,，;；]/);
  const out = [];
  for (const raw of arr) {
    const t = String(raw).trim().slice(0, 12);
    if (t && !out.includes(t)) out.push(t);
    if (out.length === 4) break;
  }
  return out;
}

function editBook(bookId, body) {
  const b = findBook(bookId);
  if (!b) return { status: 404, payload: { ok: false, message: 'Book not found' } };

  const version = Number(body.version);
  // no auto-retry for edits: a person must re-confirm, otherwise the last write overwrites the first
  if (b.version !== version) return conflict(b, version, 'Please refresh and edit again.');

  const title = String(body.title ?? b.title).trim();
  const author = String(body.author ?? b.author).trim();
  const copies = Number(body.copies ?? b.copies);
  const note = String(body.note ?? b.note ?? '').trim().slice(0, 80);
  const tags = cleanTags(body.tags);
  const member = String(body.member || '').trim() || 'Anonymous';

  if (!title || !author) return { status: 400, payload: { ok: false, message: 'Title and author are required' } };
  if (!Number.isInteger(copies) || copies < 1 || copies > 99) {
    return { status: 400, payload: { ok: false, message: 'Copies must be a whole number between 1 and 99' } };
  }

  const out = b.borrowers.length + (b.reservedFor ? 1 : 0);
  if (copies < out) {
    return { status: 400, payload: { ok: false, message: `Copies cannot be fewer than the copies already out (${out})` } };
  }

  const before = { title: b.title, copies: b.copies, note: b.note || '', tags: (b.tags || []).join(',') };
  b.title = title;
  b.author = author;
  b.copies = copies;
  b.note = note;
  if (tags) b.tags = tags;
  b.version += 1;
  syncAvailable(b);

  const changes = [];
  if (before.title !== b.title) changes.push('title');
  if (before.copies !== b.copies) changes.push(`copies ${before.copies}→${b.copies}`);
  if (before.note !== b.note) changes.push('note');
  if (before.tags !== (b.tags || []).join(',')) changes.push('tags');

  addHistory(b, 'edit', member, changes.length ? 'Changed ' + changes.join(', ') : 'Saved (no field changed)');
  save();
  addLog(
    `${member} edited "${b.title}"${changes.length ? ': ' + changes.join(', ') : ' (no field changed)'} — version v${b.version}`,
    'ok'
  );
  return { status: 200, payload: { ok: true, message: `Saved — now at version v${b.version}`, book: publicBook(b) } };
}

/* ---------------- add book ---------------- */

function addBook(title, author, copies, tags) {
  const n = Number(copies);
  if (!title || !author) return { status: 400, payload: { ok: false, message: 'Title and author are required' } };
  if (!Number.isInteger(n) || n < 1 || n > 99) {
    return { status: 400, payload: { ok: false, message: 'Copies must be a whole number between 1 and 99' } };
  }
  const b = {
    id: nextBookId++, title, author, copies: n,
    borrowers: [], version: 1, reservedFor: null, note: '',
    tags: cleanTags(tags) || [], history: [], reviews: [],
  };
  addHistory(b, 'add', '', `${n} copies`);
  syncAvailable(b);
  books.push(b);
  save();
  addLog(`${title} added to the catalogue — ${n} copies`, 'info');
  return { status: 201, payload: { ok: true, message: 'Book added', book: publicBook(b) } };
}

/* ---------------- reviews ---------------- */

function addReview(bookId, body) {
  const b = findBook(bookId);
  if (!b) return { status: 404, payload: { ok: false, message: 'Book not found' } };

  const member = String(body.member || '').trim();
  const rating = Number(body.rating);
  const comment = String(body.comment || '').trim().slice(0, 120);

  if (!member) return { status: 400, payload: { ok: false, message: 'Please fill in the current user first' } };
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return { status: 400, payload: { ok: false, message: 'Rating must be a whole number from 1 to 5' } };
  }

  const existing = b.reviews.find((r) => r.member === member);
  if (existing) {
    existing.rating = rating;
    existing.comment = comment;
    existing.time = stampDate();
    save();
    addLog(`${member} updated their review of "${b.title}": ${rating}/5`, 'ok');
    return { status: 200, payload: { ok: true, code: 'UPDATED', message: 'Review updated', book: publicBook(b) } };
  }

  b.reviews.push({ member, rating, comment, time: stampDate() });
  save();
  addLog(`${member} rated "${b.title}" ${rating}/5`, 'ok');
  return { status: 201, payload: { ok: true, message: 'Review submitted', book: publicBook(b) } };
}

function publicBook(b) {
  const { avgRating, reviewCount } = ratingOf(b);
  return { ...b, queueCount: queueOf(b.id).length, avgRating, reviewCount };
}

/* ---------------- stats ---------------- */

function buildStats() {
  const copies = books.reduce((n, b) => n + b.copies, 0);
  const onLoan = books.reduce((n, b) => n + b.borrowers.length, 0);
  const held = books.filter((b) => b.reservedFor).length;
  const available = books.reduce((n, b) => n + b.available, 0);

  const topBorrowed = books
    .map((b) => ({
      id: b.id,
      title: b.title,
      count: (b.history || []).filter((h) => h.type === 'borrow').length,
    }))
    .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title, 'zh'))
    .slice(0, 5);

  const tagMap = new Map();
  for (const b of books) for (const t of b.tags || []) tagMap.set(t, (tagMap.get(t) || 0) + 1);
  const tagCounts = [...tagMap.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh'));

  return {
    books: books.length,
    copies,
    onLoan,
    available,
    held,
    queueLength: reservations.length,
    utilisation: copies ? Math.round((onLoan / copies) * 1000) / 10 : 0,
    topBorrowed,
    tagCounts,
    recent: logs.slice(0, 12),
  };
}

/* ---------------- HTTP helpers ---------------- */

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
  '.json': 'application/json; charset=utf-8',
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

/* ---------------- routes ---------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  try {
    if (p === '/api/state' && req.method === 'GET') {
      return sendJson(res, 200, { books: books.map(publicBook), reservations, logs });
    }

    if (p === '/api/stats' && req.method === 'GET') {
      return sendJson(res, 200, buildStats());
    }

    if (p === '/api/reset' && req.method === 'POST') {
      seed();
      return sendJson(res, 200, { ok: true, message: 'Sample data restored' });
    }

    if (p === '/api/log' && req.method === 'POST') {
      const body = await readBody(req);
      addLog(String(body.msg || ''), String(body.type || 'info'));
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/books' && req.method === 'POST') {
      const body = await readBody(req);
      const r = addBook(
        String(body.title || '').trim(),
        String(body.author || '').trim(),
        body.copies,
        body.tags
      );
      return sendJson(res, r.status, r.payload);
    }

    // book detail: book + queue + history + reviews
    const detail = p.match(/^\/api\/books\/(\d+)$/);
    if (detail && req.method === 'GET') {
      const b = findBook(Number(detail[1]));
      if (!b) return sendJson(res, 404, { ok: false, message: 'Book not found' });
      return sendJson(res, 200, {
        book: publicBook(b),
        queue: queueOf(b.id).map((r) => r.member),
        history: b.history,
        reviews: b.reviews.slice().sort((x, y) => (x.time < y.time ? 1 : -1)),
      });
    }

    if (detail && req.method === 'PATCH') {
      const body = await readBody(req);
      const r = editBook(Number(detail[1]), body);
      return sendJson(res, r.status, r.payload);
    }

    const review = p.match(/^\/api\/books\/(\d+)\/reviews$/);
    if (review && req.method === 'POST') {
      const body = await readBody(req);
      const r = addReview(Number(review[1]), body);
      return sendJson(res, r.status, r.payload);
    }

    const member = p.match(/^\/api\/members\/(.+)$/);
    if (member && req.method === 'GET') {
      const name = decodeURIComponent(member[1]).trim();
      const loans = [];
      const holds = [];
      const reviews = [];
      for (const b of books) {
        for (const x of b.borrowers) {
          if (x.member === name) {
            loans.push({
              id: b.id, title: b.title, author: b.author, since: x.since,
              copies: b.copies, available: b.available, version: b.version,
            });
          }
        }
        const q = queueOf(b.id).map((r) => r.member);
        const pos = q.indexOf(name);
        if (pos >= 0) holds.push({ bookId: b.id, title: b.title, position: pos + 1, total: q.length });
        for (const r of b.reviews) {
          if (r.member === name) {
            reviews.push({ bookId: b.id, title: b.title, rating: r.rating, comment: r.comment, time: r.time });
          }
        }
      }
      return sendJson(res, 200, { member: name, loans, holds, reviews });
    }

    const m = p.match(/^\/api\/books\/(\d+)\/(borrow|return)$/);
    if (m && req.method === 'POST') {
      const body = await readBody(req);
      const id = Number(m[1]);
      const who = String(body.member || '').trim() || 'Anonymous';
      const version = Number(body.version);
      if (!Number.isFinite(version)) {
        return sendJson(res, 400, { ok: false, message: 'Missing version parameter' });
      }
      const r = m[2] === 'borrow' ? borrow(id, who, version) : giveBack(id, who, version);
      return sendJson(res, r.status, r.payload);
    }

    serveStatic(p, res);
  } catch (err) {
    sendJson(res, 500, { ok: false, message: 'Server error: ' + err.message });
  }
});

if (!load()) seed();

server.listen(PORT, () => {
  console.log(`\n  📚 Shared Digital Book Library is running`);
  console.log(`  → http://localhost:${PORT}\n`);
});
