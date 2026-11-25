const B = 'http://localhost:3000';
const j = async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) });
const get = (p) => fetch(B + p).then(j);
const post = (p, b) => fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(j);
const patch = (p, b) => fetch(B + p, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(j);

const book = async (id) => (await get('/api/state')).data.books.find(b => b.id === id);
const results = [];
const check = (name, ok, detail) => results.push({ name, ok, detail });

await post('/api/reset', {});

// BL-1 共享书目
const add = await post('/api/books', { title: '重构', author: 'Martin Fowler', copies: 2 });
const s1 = (await get('/api/state')).data.books.find(b => b.title === '重构');
check('BL-1 新增并出现在共享列表', add.status === 201 && !!s1, `返回 ${add.status}，新书 id=${s1 && s1.id}`);

// BL-2 借还
let b1 = await book(1); const v1 = b1.version, a1 = b1.available;
const bo = await post('/api/books/1/borrow', { member: '张三', version: v1 });
b1 = await book(1);
const markedAsBorrowed = b1.borrowers.some(x => x.member === '张三');
const rt = await post('/api/books/1/return', { member: '张三', version: b1.version });
const b1b = await book(1);
check('BL-2 借出库存 -1 并标记借出人', bo.status === 200 && b1.available === a1 - 1 && markedAsBorrowed, `${a1}→${b1.available}，借出人=${b1.borrowers.map(x=>x.member)}`);
check('BL-2 归还库存 +1', rt.status === 200 && b1b.available === a1, `${b1.available}→${b1b.available}`);

// BL-2 库存永不为负（10 个并发借 1 本）
await post('/api/reset', {});
const before2 = await book(2);
const many = await Promise.all(Array.from({ length: 10 }, (_, i) =>
  post('/api/books/2/borrow', { member: 'u' + i, version: before2.version })));
const after2 = await book(2);
const borrowedCount = after2.borrowers.length;
check('BL-2 10 个并发借 1 本，库存不为负', after2.available >= 0 && borrowedCount === 1, `可借=${after2.available}，借出人数=${borrowedCount}`);

// BL-2b 零库存借书：库存与版本都不变
await post('/api/reset', {});
const z0 = await book(3);
const zr = await post('/api/books/3/borrow', { member: 'queue-check', version: z0.version });
const z1 = await book(3);
check(
  'BL-2 zero-stock borrow keeps stock unchanged',
  zr.data.code === 'OUT_OF_STOCK' && z1.available === 0 && z1.version === z0.version,
  `available=${z1.available}, version v${z0.version}->v${z1.version}`
);

// BL-3 最后一本：恰好一个借到
await post('/api/reset', {});
const b3 = await book(2); // 1 本
const [r1, r2] = await Promise.all([
  post('/api/books/2/borrow', { member: '甲', version: b3.version }),
  post('/api/books/2/borrow', { member: '乙', version: b3.version }),
]);
const b3after = await book(2);
const gotIt = [r1, r2].filter(r => r.status === 200 && /借书成功/.test(r.data.message || ''));
const loser = [r1, r2].find(r => !/借书成功/.test(r.data.message || ''));
check('BL-3 恰好一人借到', gotIt.length === 1, `成功借书 ${gotIt.length} 人`);
check('BL-3 库存保持一致', b3after.available === 0 && b3after.borrowers.length === 1, `可借=${b3after.available}`);
check('BL-3 每笔成功变更版本 +1', b3after.version === b3.version + 1, `v${b3.version}→v${b3after.version}`);
check('BL-3 输家收到明确提示', !!loser && /队列|冲突/.test(loser.data.message), `提示：「${loser && loser.data.message}」`);

// BL-4 并发编辑
await post('/api/reset', {});
const b4 = await book(1);
const [e1, e2] = await Promise.all([
  patch('/api/books/1', { member: '甲', version: b4.version, title: 'Clean Code', copies: 3, note: '甲写的' }),
  patch('/api/books/1', { member: '乙', version: b4.version, title: 'Clean Code', copies: 3, note: '乙写的' }),
]);
const codes = [e1.status, e2.status].sort();
const b4after = await book(1);
check('BL-4 后提交者被阻止', codes[0] === 200 && codes[1] === 409, `返回码 ${codes}`);
check('BL-4 被覆盖风险消除（只有一人写入）', b4after.note === '甲写的' || b4after.note === '乙写的', `最终备注：${b4after.note}`);

// BL-5 队列
await post('/api/reset', {});
const q1 = await post('/api/books/3/borrow', { member: '王五', version: (await book(3)).version });
const q2 = await post('/api/books/3/borrow', { member: '赵六', version: (await book(3)).version });
const st5 = (await get('/api/state')).data;
check('BL-5 库存 0 时入队', /队列/.test(q1.data.message) && /队列/.test(q2.data.message), `队列=${st5.reservations.map(r=>r.member)}`);
const ret5 = await post('/api/books/3/return', { member: '张三', version: (await book(3)).version });
const b5 = await book(3);
check('BL-5 归还时按 FIFO 预留给队首', b5.reservedFor === '王五', `预留=${b5.reservedFor}，剩余队列=${(await get('/api/state')).data.reservations.map(r=>r.member)}`);
const skip = await post('/api/books/3/borrow', { member: '赵六', version: b5.version });
check('BL-5 队列顺序不可跳过', skip.status === 409 && skip.data.code === 'RESERVED', `插队返回 ${skip.status}`);

// BL-7 审计
const logs = (await get('/api/state')).data.logs;
const okLog = logs.some(l => l.time && /借出|归还|编辑/.test(l.msg));
check('BL-7 日志含时间/动作/用户', okLog, `共 ${logs.length} 条，例：「${logs[0] && logs[0].msg}」`);

// BL-8 备注走版本校验
await post('/api/reset', {});
const b8 = await book(1);
const n1 = await patch('/api/books/1', { member: '张三', version: b8.version, title: 'Clean Code', copies: 3, note: '2 楼书架' });
const b8b = await book(1);
const n2 = await patch('/api/books/1', { member: '张三', version: b8.version, title: 'Clean Code', copies: 3, note: '3 楼书架' });
check('BL-8 备注可保存', n1.status === 200 && b8b.note === '2 楼书架', `备注=${b8b.note}`);
check('BL-8 备注受版本校验', n2.status === 409, `用旧版本保存返回 ${n2.status}`);

// 输出
let pass = 0;
for (const r of results) {
  console.log(`${r.ok ? '✅' : '❌'} ${r.name.padEnd(28)} ${r.detail}`);
  if (r.ok) pass++;
}
console.log(`\n${pass}/${results.length} 通过`);
await post('/api/reset', {});
