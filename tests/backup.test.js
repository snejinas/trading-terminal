const E = require('../.test-build/engine.js');
const B = require('../.test-build/backup.js');
const assert = require('assert');
const syms = new Set(['X', 'Y']);
const mk = (asks, bids) => ({ price: { X: 100 }, bid: () => bids[0][0], ask: () => asks[0][0], depth: () => ({ asks, bids }) });
const book = mk([[100.1, 1], [100.2, 2], [100.5, 10]], [[100, 1], [99.9, 2], [99.5, 10]]);

// an account with a position, a resting order, several fills
let a = new E.Account();
a.submit(book, { sym: 'X', side: 'BUY', type: 'MKT', qty: 2 });
a.submit(book, { sym: 'X', side: 'SELL', type: 'MKT', qty: 0.5 });
a.submit(book, { sym: 'X', side: 'BUY', type: 'LMT', qty: 1, limit: 90 });

const now = new Date(2026, 10, 24, 9, 5);
const text = JSON.stringify(B.buildBackup('binance', a, now), null, 2);
const clone = () => JSON.parse(text);

// 1) round trip is lossless and the summary is right
let r = B.parseBackup(text, 'binance', syms);
assert(r.ok, r.error);
assert.deepStrictEqual(r.account.snapshot(), a.snapshot());
assert.deepStrictEqual(r.summary, { exportedAt: now.toISOString(), source: 'binance', cash: a.cash, realized: a.realized, fees: a.fees, positions: 1, orders: 1, fills: 2 });
assert.strictEqual(r.dropped, 0);

// 2) filename is stable and filesystem-safe
assert.strictEqual(B.backupFilename('binance', now), 'paper-account-binance-20261124-0905.json');
assert(/^[\w.-]+$/.test(B.backupFilename('sim', now)));

// 3) wrong feed is rejected with a human explanation, not silently mangled
r = B.parseBackup(text, 'sim', syms); assert(!r.ok && /Binance feed.*simulated feed/.test(r.error), r.error);

// 4) not-a-backup / garbage inputs: every one fails cleanly (never throws)
const bad = ['', 'not json', '[]', 'null', '42', '"x"', '{}', JSON.stringify({ kind: 'other', version: 1 }),
  JSON.stringify({ ...clone(), version: 2 }), JSON.stringify({ ...clone(), kind: undefined }),
  JSON.stringify({ ...clone(), source: 'kraken' }), JSON.stringify({ ...clone(), account: null }),
  JSON.stringify({ ...clone(), account: { v: 1 } }), JSON.stringify({ ...clone(), account: 'oops' }),
  '{"kind":"lifeinception-paper-account","version":1,"source":"binance","account":'];
for (const t of bad) { const x = B.parseBackup(t, 'binance', syms); assert(!x.ok && typeof x.error === 'string' && x.error.length > 10, t.slice(0, 50)); }

// 5) tampered account contents are rejected
const tamper = fn => { const c = clone(); fn(c.account); return JSON.stringify(c); };
const tampers = [
  c => { c.cash = 'rich'; }, c => { c.cash = null; }, c => { c.fees = Infinity; /* JSON -> null */ },
  c => { c.fills[0].qty = -1; }, c => { c.fills[0].price = 0; }, c => { c.fills[0].fee = -5; }, c => { c.fills[0].role = 'whale'; },
  c => { c.fills[0].side = 'HODL'; }, c => { c.fills[0].levels = 0; },
  c => { c.fills[1].id = c.fills[0].id; },                 // duplicate fill id
  c => { c.orders.push({ ...c.orders[0] }); },             // duplicate order id
  c => { c.orders[0].type = 'MKT'; },                       // market orders can't rest
  c => { c.orders[0].limit = -1; }, c => { c.positions.X.qty = 0; },
];
for (const [i, fn] of tampers.entries()) assert(!B.parseBackup(tamper(fn), 'binance', syms).ok, 'tamper #' + i);

// 6) counters are pushed past every id in the file, so new orders/fills can never collide
let c = clone(); c.account.nextOrder = 1; c.account.nextFill = 1;
r = B.parseBackup(JSON.stringify(c), 'binance', syms); assert(r.ok);
const maxOrderId = Math.max(...r.account.orders.map(o => o.id), ...r.account.fills.map(f => f.orderId));
const maxFillId = Math.max(...r.account.fills.map(f => f.id));
r.account.submit(book, { sym: 'X', side: 'BUY', type: 'MKT', qty: 0.1 });
assert(r.account.fills[0].orderId > maxOrderId, 'order id does not collide');
assert(r.account.fills[0].id > maxFillId, 'fill id does not collide');

// 7) unknown properties in the file are stripped, not carried into the account
c = clone(); c.account.fills[0].evil = '<script>'; c.account.fills[0].__proto__ = { polluted: true }; c.account.extra = 1;
r = B.parseBackup(JSON.stringify(c).replace('"__proto__"', '"__proto__"'), 'binance', syms); assert(r.ok);
assert(!('evil' in r.account.fills[r.account.fills.length - 1]) && !('evil' in r.account.fills[0]));
assert.strictEqual({}.polluted, undefined, 'no prototype pollution');
// hostile JSON with a real "__proto__" key and a "constructor" position
const hostile = JSON.stringify(clone()).replace('"positions":{', '"positions":{"__proto__":{"qty":1,"avg":1},"constructor":{"qty":1,"avg":1},');
r = B.parseBackup(hostile, 'binance', syms); assert(r.ok, r.error); assert.strictEqual(r.dropped, 2, 'unknown position keys are dropped');
assert.strictEqual({}.qty, undefined); assert.deepStrictEqual(Object.keys(r.account.positions), ['X']);

// 8) symbols not in this feed are dropped and counted (not fatal)
r = B.parseBackup(text, 'binance', new Set(['Y'])); assert(r.ok); assert.strictEqual(r.dropped, 2); assert.deepStrictEqual(r.account.positions, {});

// 9) size limits: huge text and absurd order counts are refused
assert(!B.parseBackup('x'.repeat(B.MAX_BACKUP_BYTES + 1), 'binance', syms).ok);
c = clone(); c.account.orders = Array.from({ length: B.MAX_BACKUP_ORDERS + 1 }, (_, i) => ({ id: 1000 + i, sym: 'X', side: 'BUY', type: 'LMT', qty: 1, limit: 1, ts: 1 }));
r = B.parseBackup(JSON.stringify(c), 'binance', syms); assert(!r.ok && /unreasonable/.test(r.error));

// 10) a restored account is a working Account whose rates are the defaults (setting is not in the file)
r = B.parseBackup(text, 'binance', syms); assert(r.account instanceof E.Account); assert.deepStrictEqual(r.account.rates, E.FEE_RATE);
assert(!JSON.stringify(clone()).includes('rates') && !JSON.stringify(clone()).includes('tier'));

console.log('backup tests passed');
