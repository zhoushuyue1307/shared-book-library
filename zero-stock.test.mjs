#!/usr/bin/env node
/**
 * Concurrency regression checks for the borrow path.
 *
 *   node server.js              # in one terminal
 *   node zero-stock.test.mjs    # in another
 *
 * Exits with code 1 if any check fails.
 */

const BASE = process.env.BASE_URL || 'http://localhost:3000';
let passed = 0;
const failed = [];

const post = (path, body) =>
  fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }));

const state = () => fetch(BASE + '/api/state').then((r) => r.json());
const book = async (id) => (await state()).books.find((b) => b.id === id);

function check(name, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`);
  } else {
    failed.push(name);
    console.log(`  FAIL  ${name}${detail ? '  — ' + detail : ''}`);
  }
}

async function main() {
  console.log(`\nBorrow-path regression checks against ${BASE}\n`);

  // ---------------------------------------------------------------- A
  // A book with no copies left must not lose another copy.
  await post('/api/reset', {});
  const before = await book(3); // seeded with 0 available
  const res = await post('/api/books/3/borrow', { member: 'queue-check', version: before.version });
  const after = await book(3);

  console.log('[A] borrow at zero stock');
  check('returns the OUT_OF_STOCK code', res.data.code === 'OUT_OF_STOCK', `code=${res.data.code}`);
  check('available stock stays at zero', after.available === 0, `available=${after.available}`);
  check('record version is not bumped by a queued request', after.version === before.version,
    `v${before.version} -> v${after.version}`);

  // ---------------------------------------------------------------- B
  // Two members race for the last copy: exactly one may win.
  await post('/api/reset', {});
  const b0 = await book(2); // exactly 1 copy
  const [r1, r2] = await Promise.all([
    post('/api/books/2/borrow', { member: 'alice', version: b0.version }),
    post('/api/books/2/borrow', { member: 'bob', version: b0.version }),
  ]);
  const b1 = await book(2);
  const winners = [r1, r2].filter((r) => r.status === 200 && /借书成功/.test(r.data.message || ''));

  console.log('\n[B] two members race for the last copy');
  check('exactly one borrow succeeds', winners.length === 1, `${winners.length} winner(s)`);
  check('stock never goes negative', b1.available >= 0, `available=${b1.available}`);

  // ---------------------------------------------------------------- C
  // A returned copy goes to the head of the FIFO queue.
  await post('/api/reset', {});
  await post('/api/books/3/borrow', { member: 'alice', version: (await book(3)).version });
  await post('/api/books/3/borrow', { member: 'bob', version: (await book(3)).version });
  await post('/api/books/3/return', { member: 'carol', version: (await book(3)).version });
  const b2 = await book(3);

  console.log('\n[C] reservation queue order');
  check('returned copy is reserved for the first in queue', b2.reservedFor === 'alice', `reservedFor=${b2.reservedFor}`);

  await post('/api/reset', {});

  console.log(`\n${passed} passed, ${failed.length} failed\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nCould not reach the server:', err.message);
  console.error('Start it first:  node server.js\n');
  process.exit(1);
});
