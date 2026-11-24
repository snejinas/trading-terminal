const E = require('../.test-build/engine.js');
const assert = require('assert');
const syms = new Set(['X', 'Y']);
const mk = (asks, bids) => ({ price: { X: 100 }, bid: () => bids[0][0], ask: () => asks[0][0], depth: () => ({ asks, bids }) });
const book = mk([[100.1, 1], [100.2, 2], [100.5, 10]], [[100, 1], [99.9, 2], [99.5, 10]]);

// build some state: a fill, a position, a resting order, a partial
let a = new E.Account();
a.submit(book, { sym: 'X', side: 'BUY', type: 'MKT', qty: 2 });
a.submit(book, { sym: 'X', side: 'BUY', type: 'LMT', qty: 1, limit: 90 });
a.submit(book, { sym: 'X', side: 'SELL', type: 'MKT', qty: 0.5 });

// 1) JSON round trip preserves everything, including id counters
const json = JSON.parse(JSON.stringify(a.snapshot()));
const { account: b, dropped } = E.Account.restore(json, syms);
assert.strictEqual(dropped, 0);
for (const k of ['cash', 'realized', 'fees']) assert.strictEqual(b[k], a[k], k);
assert.deepStrictEqual(b.positions, a.positions);
assert.deepStrictEqual(b.orders, a.orders);
assert.deepStrictEqual(b.fills, a.fills);
assert.strictEqual(b.signature(), a.signature());

// 2) restored account keeps issuing fresh, non-colliding ids
const maxOrder = Math.max(...b.orders.map(o => o.id), ...b.fills.map(f => f.orderId));
b.submit(book, { sym: 'X', side: 'BUY', type: 'MKT', qty: 0.1 });
assert(b.fills[0].orderId > maxOrder, 'order id continues');
assert(b.fills[0].id > Math.max(...a.fills.map(f => f.id)), 'fill id continues');

// 3) signature changes on every kind of mutation, so persist() can't miss one
const s0 = a.signature();
a.cancel('all'); assert.notStrictEqual(a.signature(), s0, 'cancel');

// 4) unknown symbols are dropped and counted, rest kept
const r2 = E.Account.restore(json, new Set(['Y']));
assert.strictEqual(r2.dropped, 2); // one position + one order
assert.deepStrictEqual(r2.account.positions, {}); assert.strictEqual(r2.account.orders.length, 0);

// 5) malformed / hostile data is rejected (null), never throws
const bad = [null, 42, 'x', {}, { v: 2 }, { ...json, cash: 'lots' }, { ...json, cash: NaN }, { ...json, cash: null },
  { ...json, positions: { X: { qty: -1, avg: 1 } } }, { ...json, positions: { X: { qty: 1, avg: 'a' } } },
  { ...json, orders: [{ id: 1, sym: 'X', side: 'BUY', type: 'MKT', qty: 1, ts: 1 }] },
  { ...json, orders: [{ id: 1, sym: 'X', side: 'HODL', type: 'LMT', qty: 1, limit: 1, ts: 1 }] },
  { ...json, fills: [{ id: 1 }] }, { ...json, fills: 'nope' }, { ...json, orders: null }];
for (const x of bad) assert.strictEqual(E.Account.restore(x, syms), null, JSON.stringify(x)?.slice(0, 60));

// 6) a restored account is a real Account (methods work, not just data)
assert(b instanceof E.Account); assert.strictEqual(typeof b.equity({ price: { X: 100 } }), 'number');
console.log('persist tests passed');
