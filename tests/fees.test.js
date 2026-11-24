const E = require('../.test-build/engine.js');
const assert = require('assert');
const near = (a, b, m) => assert(Math.abs(a - b) < 1e-6, `${m}: ${a} vs ${b}`);
const mk = (asks, bids) => ({ price: { X: 100 }, bid: () => bids[0][0], ask: () => asks[0][0], depth: () => ({ asks, bids }) });
const book = mk([[100.1, 1], [100.2, 2], [100.5, 10]], [[100, 1], [99.9, 2], [99.5, 10]]);
const T = E.FEE_RATE.taker, M = E.FEE_RATE.maker;

// 1) market buy: taker fee on notional, cash debited notional+fee, fee in cost basis
let a = new E.Account();
assert.strictEqual(a.submit(book, { sym: 'X', side: 'BUY', type: 'MKT', qty: 2.5 }), null);
let f = a.fills[0];
const notional = 100.1 + 1.5 * 100.2;
near(f.fee, notional * T, 'fee'); assert.strictEqual(f.role, 'taker');
near(a.cash, E.START_CASH - notional - f.fee, 'cash');
near(a.fees, f.fee, 'total fees');
near(a.positions.X.avg, (notional + f.fee) / 2.5, 'avg incl fee');

// 2) round trip at an unchanged price loses roughly two fees
a = new E.Account();
const flat = mk([[100, 5]], [[100, 5]]);
a.submit(flat, { sym: 'X', side: 'BUY', type: 'MKT', qty: 5 });
a.submit(flat, { sym: 'X', side: 'SELL', type: 'MKT', qty: 5 });
near(a.fees, 500 * T + 500 * T, 'two fees');
near(a.realized, -(500 * T + 500 * T), 'realized net of both fees');
near(a.cash, E.START_CASH - a.fees, 'cash lost == fees');
assert.strictEqual(Object.keys(a.positions).length, 0);

// 3) resting limit order that fills later is a MAKER fill; the marketable part at submit is TAKER
a = new E.Account();
a.submit(book, { sym: 'X', side: 'BUY', type: 'LMT', qty: 5, limit: 100.2 }); // 3 now, 2 rest
assert.strictEqual(a.fills[0].role, 'taker'); assert.strictEqual(a.orders[0].qty, 2);
a.match(mk([[99, 5]], [[98.9, 5]]));
assert.strictEqual(a.fills[0].role, 'maker'); near(a.fills[0].fee, 2 * 99 * M, 'maker fee');

// 4) an older resting order must NOT be flagged taker just because a new order is submitted
a = new E.Account();
a.submit(mk([[101, 5]], [[100, 5]]), { sym: 'X', side: 'BUY', type: 'LMT', qty: 1, limit: 99 }); // rests
const fillsBefore = a.fills.length;
a.submit(mk([[98, 5]], [[97, 5]]), { sym: 'X', side: 'BUY', type: 'MKT', qty: 1 }); // new mkt order; resting one is now marketable too
assert.strictEqual(a.fills.length, fillsBefore + 1); assert.strictEqual(a.fills[0].role, 'taker');
assert.strictEqual(a.orders.length, 1); // resting order untouched until the next match()
a.match(mk([[98, 5]], [[97, 5]]));
assert.strictEqual(a.fills[0].role, 'maker');

// 5) buying power includes the fee: exactly affordable notional is rejected, notional/(1+fee) is accepted
a = new E.Account();
const px = mk([[100, 1e9]], [[100, 1e9]]);
let err = a.submit(px, { sym: 'X', side: 'BUY', type: 'MKT', qty: E.START_CASH / 100 });
assert(/buying power/.test(err), 'cannot spend 100% of cash on notional once fee is added');
assert.strictEqual(a.submit(px, { sym: 'X', side: 'BUY', type: 'MKT', qty: E.START_CASH / 100 / (1 + T) - 1e-6 }), null);
assert(a.cash >= -1e-6, 'cash never negative: ' + a.cash);

console.log('fee tests passed');
