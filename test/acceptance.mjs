const B = process.env.BASE || 'http://localhost:3000';
const j = async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) });
const get = (p) => fetch(B + p).then(j);
const post = (p, b) => fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(j);
const patch = (p, b) => fetch(B + p, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(j);

const book = async (id) => (await get('/api/state')).data.books.find(b => b.id === id);
const results = [];
const check = (name, ok, detail) => results.push({ name, ok, detail });

await post('/api/reset', {});

// BL-1 shared catalogue
const add = await post('/api/books', { title: 'Refactoring', author: 'Martin Fowler', copies: 2 });
const s1 = (await get('/api/state')).data.books.find(b => b.title === 'Refactoring');
check('BL-1 add a book to the shared catalogue', add.status === 201 && !!s1, `HTTP ${add.status}, new id=${s1 && s1.id}`);

// BL-2 borrow and return
let b1 = await book(1); const v1 = b1.version, a1 = b1.available;
const bo = await post('/api/books/1/borrow', { member: 'Alice', version: v1 });
b1 = await book(1);
const markedAsBorrowed = b1.borrowers.some(x => x.member === 'Alice');
const rt = await post('/api/books/1/return', { member: 'Alice', version: b1.version });
const b1b = await book(1);
check('BL-2 borrow lowers stock by 1', bo.status === 200 && b1.available === a1 - 1 && markedAsBorrowed, `${a1}→${b1.available}, on loan=${b1.borrowers.map(x=>x.member)}`);
check('BL-2 return raises stock by 1', rt.status === 200 && b1b.available === a1, `${b1.available}→${b1b.available}`);

// BL-2 stock never goes negative (10 concurrent borrows for 1 copy)
await post('/api/reset', {});
const before2 = await book(2);
const many = await Promise.all(Array.from({ length: 10 }, (_, i) =>
  post('/api/books/2/borrow', { member: 'u' + i, version: before2.version })));
const after2 = await book(2);
const borrowedCount = after2.borrowers.length;
check('BL-2 10 concurrent borrows, 1 copy', after2.available >= 0 && borrowedCount === 1, `available=${after2.available}, on loan=${borrowedCount}`);

// BL-2b borrowing at zero stock: stock and version unchanged
await post('/api/reset', {});
const z0 = await book(3);
const zr = await post('/api/books/3/borrow', { member: 'queue-check', version: z0.version });
const z1 = await book(3);
check(
  'BL-2 zero-stock borrow keeps stock unchanged',
  zr.data.code === 'OUT_OF_STOCK' && z1.available === 0 && z1.version === z0.version,
  `available=${z1.available}, version v${z0.version}->v${z1.version}`
);

// BL-3 last copy: exactly one winner
await post('/api/reset', {});
const b3 = await book(2); // only 1 copy
const [r1, r2] = await Promise.all([
  post('/api/books/2/borrow', { member: 'Alice', version: b3.version }),
  post('/api/books/2/borrow', { member: 'Ben', version: b3.version }),
]);
const b3after = await book(2);
const gotIt = [r1, r2].filter(r => r.status === 200 && /Borrowed successfully/.test(r.data.message || ''));
const loser = [r1, r2].find(r => !/Borrowed successfully/.test(r.data.message || ''));
check('BL-3 exactly one borrow wins', gotIt.length === 1, `${gotIt.length} successful borrow(s)`);
check('BL-3 stock stays consistent', b3after.available === 0 && b3after.borrowers.length === 1, `available=${b3after.available}`);
check('BL-3 version +1 per accepted change', b3after.version === b3.version + 1, `v${b3.version}→v${b3after.version}`);
check('BL-3 loser gets a clear message', !!loser && /queue|conflict/i.test(loser.data.message), `message: "${loser && loser.data.message}"`);

// BL-4 concurrent edit
await post('/api/reset', {});
const b4 = await book(1);
const [e1, e2] = await Promise.all([
  patch('/api/books/1', { member: 'Alice', version: b4.version, title: 'Clean Code', copies: 3, note: 'Alice was here' }),
  patch('/api/books/1', { member: 'Ben', version: b4.version, title: 'Clean Code', copies: 3, note: 'Ben was here' }),
]);
const codes = [e1.status, e2.status].sort();
const b4after = await book(1);
check('BL-4 second editor is blocked', codes[0] === 200 && codes[1] === 409, `status codes ${codes}`);
check('BL-4 no lost update (one writer)', b4after.note === 'Alice was here' || b4after.note === 'Ben was here', `final note: ${b4after.note}`);

// BL-5 reservation queue
await post('/api/reset', {});
const q1 = await post('/api/books/3/borrow', { member: 'Chloe', version: (await book(3)).version });
const q2 = await post('/api/books/3/borrow', { member: 'Dan', version: (await book(3)).version });
const st5 = (await get('/api/state')).data;
check('BL-5 zero stock queues the member', /queue/.test(q1.data.message) && /queue/.test(q2.data.message), `queue=${st5.reservations.map(r=>r.member)}`);
const ret5 = await post('/api/books/3/return', { member: 'Alice', version: (await book(3)).version });
const b5 = await book(3);
check('BL-5 return is held for queue head', b5.reservedFor === 'Chloe', `held for=${b5.reservedFor}, rest of queue=${(await get('/api/state')).data.reservations.map(r=>r.member)}`);
const skip = await post('/api/books/3/borrow', { member: 'Dan', version: b5.version });
check('BL-5 queue order cannot be skipped', skip.status === 409 && skip.data.code === 'RESERVED', `queue-jump returned ${skip.status}`);

// BL-7 audit log
const logs = (await get('/api/state')).data.logs;
const okLog = logs.some(l => l.time && /borrow|return|edit/i.test(l.msg));
check('BL-7 log has time/action/user', okLog, `${logs.length} entries, e.g. "${logs[0] && logs[0].msg}"`);

// BL-8 note goes through the version check
await post('/api/reset', {});
const b8 = await book(1);
const n1 = await patch('/api/books/1', { member: 'Alice', version: b8.version, title: 'Clean Code', copies: 3, note: '2F shelf' });
const b8b = await book(1);
const n2 = await patch('/api/books/1', { member: 'Alice', version: b8.version, title: 'Clean Code', copies: 3, note: '3F shelf' });
check('BL-8 note is saved', n1.status === 200 && b8b.note === '2F shelf', `note=${b8b.note}`);
check('BL-8 stale note save is rejected', n2.status === 409, `old version returned ${n2.status}`);

// BL-9 book detail: history + reviews
await post('/api/reset', {});
const d9 = await get('/api/books/1');
check('BL-9 detail returns history and reviews', d9.status === 200 && d9.data.history.length >= 3 && d9.data.reviews.length === 2,
  `${d9.data.history.length} history entries, ${d9.data.reviews.length} reviews`);

const rv = await post('/api/books/1/reviews', { member: 'Alice', rating: 5, comment: 'test review' });
const d9b = await get('/api/books/1');
check('BL-9 average updates after a review', rv.status === 201 && d9b.data.book.reviewCount === 3,
  `average ${d9b.data.book.avgRating}, ${d9b.data.book.reviewCount} reviews`);

// BL-10 My loans
const me = await get('/api/members/' + encodeURIComponent('Alice'));
check('BL-10 my loans lists active loans', me.status === 200 && me.data.loans.length >= 1, `${me.data.loans.length} on loan`);

// BL-11 statistics add up
const st = await get('/api/stats');
check('BL-11 statistics add up', st.status === 200 && st.data.copies === st.data.onLoan + st.data.available + st.data.held,
  `copies ${st.data.copies} = on loan ${st.data.onLoan} + available ${st.data.available} + held ${st.data.held}`);

// BL-6 tags saved through the version check
await post('/api/reset', {});
const b6 = await book(1);
const tg = await patch('/api/books/1', { member: 'Alice', version: b6.version, tags: ['test-tag'] });
const b6after = await book(1);
check('BL-6 tags are saved and listed', tg.status === 200 && b6after.tags.includes('test-tag'), `tags=${b6after.tags}`);

// output
let pass = 0;
for (const r of results) {
  console.log(`${r.ok ? '✅' : '❌'} ${r.name.padEnd(28)} ${r.detail}`);
  if (r.ok) pass++;
}
console.log(`\n${pass}/${results.length} checks passed`);
await post('/api/reset', {});
