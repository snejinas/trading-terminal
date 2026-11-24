const E = require('../.test-build/engine.js');
const S = require('../.test-build/slippage.js');
const assert = require('assert');
const near = (a, b, m, eps = 1e-9) => assert(Math.abs(a - b) < eps, `${m}: ${a} vs ${b}`);

// BTC-like book: best ask 100.00, 10 levels of 1.0 each, 0.01 apart upward; bids mirror below.
const mk = (asks, bids, price = 100) => ({ price: { X: price }, bid: () => bids[0][0], ask: () => asks[0][0], depth: () => ({ asks, bids }) });
const ladder = (start, step, n, size) => Array.from({ length: n }, (_, i) => [start + i * step, size]);
const book = (step = 0.01, size = 1, n = 10) => mk(ladder(100.0, step, n, size), ladder(99.99, -step, n, size));

// 1) small order at the touch: no slippage, severity info, no alarms
let e = S.estimateSlippage(book(), 'X', 'BUY', 0.5);
assert.strictEqual(e.severity, 'info'); assert.strictEqual(e.slipBps, 0); assert.strictEqual(e.levels, 1); assert.deepStrictEqual(e.reasons, []); assert.strictEqual(e.hasDepth, true);

// 2) the numbers: buy 3 walks 100.00, 100.01, 100.02 -> avg 100.01, slip 0.01 (1 bp), cost 0.03
e = S.estimateSlippage(book(), 'X', 'BUY', 3);
near(e.avg, 100.01, 'avg'); near(e.slipPrice, 0.01, 'slipPrice'); near(e.slipBps, 1, 'bps'); near(e.slipCost, 0.03, 'cost'); assert.strictEqual(e.levels, 3); near(e.worst, 100.02, 'worst');
assert.strictEqual(e.severity, 'info', '1 bp is below the warn line');
near(e.share, 0.3, 'share'); assert(e.notes.length === 1 && /Walks 3 book levels/.test(e.notes[0]), 'multi-level walk is a note when mild');

// 3) severity thresholds by bps (wide steps so impact is the driver; share kept low with deep levels)
const deep = step => mk(ladder(100.0, step, 10, 1000), ladder(99.99, -step, 10, 1000));
e = S.estimateSlippage(deep(0.05), 'X', 'BUY', 3000); // walks 3 levels: avg = 100.05 -> 5 bps
assert.strictEqual(e.severity, 'info', e.slipBps);
e = S.estimateSlippage(deep(0.2), 'X', 'BUY', 3000);  // avg 100.2 -> 20 bps
assert.strictEqual(e.severity, 'warn', String(e.slipBps)); assert(e.slipBps >= S.SLIPPAGE_WARN_BPS && e.slipBps < S.SLIPPAGE_SEVERE_BPS);
e = S.estimateSlippage(deep(0.5), 'X', 'BUY', 3000);  // avg 100.5 -> 50 bps
assert.strictEqual(e.severity, 'severe', String(e.slipBps)); assert(e.reasons.some(r => /Walks 3 book levels/.test(r)));

// 4) share-of-book drives severity even when price impact is tiny (thin book, tiny steps)
e = S.estimateSlippage(book(0.0001, 1, 10), 'X', 'BUY', 5.5); // 55% of visible 10, impact ~0.3bp
assert.strictEqual(e.severity, 'warn'); assert(e.reasons.some(r => /Takes 55% of the visible ask/.test(r)));
e = S.estimateSlippage(book(0.0001, 1, 10), 'X', 'BUY', 8.5);
assert.strictEqual(e.severity, 'severe'); assert(e.reasons.some(r => /85%/.test(r)));

// 5) market order bigger than the visible book is BLOCKED; a limit order is not
e = S.estimateSlippage(book(), 'X', 'BUY', 11);
assert.strictEqual(e.severity, 'blocked'); near(e.filled, 10, 'filled'); assert(/only 10 of 11|Only 10 of 11/.test(e.reasons[0]));
e = S.estimateSlippage(book(), 'X', 'BUY', 11, 100.05); // marketable up to 100.05 -> 6 levels, rest rests
assert.notStrictEqual(e.severity, 'blocked'); near(e.filled, 6, 'limit partial'); assert(e.notes.some(n => /remaining 5 would rest/.test(n)));
// non-marketable limit: nothing executes now, so no warning
e = S.estimateSlippage(book(), 'X', 'BUY', 5, 99.5); assert.strictEqual(e.severity, 'none'); assert.strictEqual(e.filled, 0); assert.strictEqual(e.slipBps, 0);

// 6) sells walk the bids, symmetric
e = S.estimateSlippage(book(), 'X', 'SELL', 3);
near(e.avg, 99.98, 'sell avg'); near(e.slipPrice, 0.01, 'sell slip'); assert.strictEqual(e.best, 99.99);
e = S.estimateSlippage(deep(0.5), 'X', 'SELL', 3000); assert.strictEqual(e.severity, 'severe');

// 7) wide spread alone is a warning for a marketable order
e = S.estimateSlippage(mk([[101, 1000]], [[99, 1000]]), 'X', 'BUY', 1); // 200 bps spread
assert(e.spreadBps > 190); assert.strictEqual(e.severity, 'warn'); assert(e.reasons.some(r => /Wide spread/.test(r)));

// 8) simulated feed (no depth): no depth-based alarms, hasDepth=false
const sim = { price: { X: 100 }, bid: () => 99.99, ask: () => 100.01 };
e = S.estimateSlippage(sim, 'X', 'BUY', 1e6 / 100); assert.strictEqual(e.hasDepth, false); assert.strictEqual(e.share, null); assert.strictEqual(e.slipBps, 0); assert.strictEqual(e.severity, 'info');

// 9) invalid input -> null (never throws, never NaN)
for (const bad of [[0], [-1], [NaN], [Infinity]]) assert.strictEqual(S.estimateSlippage(book(), 'X', 'BUY', ...bad), null);
assert.strictEqual(S.estimateSlippage(book(), 'NOPE', 'BUY', 1), null);
assert.strictEqual(S.estimateSlippage(book(), 'X', 'BUY', 1, -5), null);
assert.strictEqual(S.estimateSlippage(book(), 'X', 'BUY', 1, 0), null);

// 10) THE INVARIANT: the estimate equals what the engine actually fills, for many sizes/sides/types
for (const side of ['BUY', 'SELL']) for (const qty of [0.1, 1, 2.5, 4, 7.25, 10]) for (const type of ['MKT', 'LMT']) {
  const m = book(0.03, 1, 10);
  const limit = type === 'LMT' ? (side === 'BUY' ? 100.2 : 99.8) : undefined;
  const est = S.estimateSlippage(m, 'X', side, qty, limit);
  const acct = new E.Account();
  if (side === 'SELL') { acct.submit(mk(ladder(100, 0.01, 10, 1e6), ladder(99.99, -0.01, 10, 1e6)), { sym: 'X', side: 'BUY', type: 'MKT', qty: 20 }); acct.fills.length = 0; }
  const before = acct.fills.length;
  const err = acct.submit(m, { sym: 'X', side, type, qty, limit });
  if (est.severity === 'blocked') { assert(err && /visible liquidity/.test(err), 'blocked => engine rejects'); continue; }
  assert.strictEqual(err, null, `${side} ${qty} ${type}: ${err}`);
  if (est.filled === 0) { assert.strictEqual(acct.fills.length, before); continue; }
  const f = acct.fills[0];
  near(f.qty, est.filled, `filled ${side} ${qty} ${type}`); near(f.price, est.avg, `avg ${side} ${qty} ${type}`); near(f.slip, est.slipPrice, `slip ${side} ${qty} ${type}`); assert.strictEqual(f.levels, est.levels);
}

// 11) after our own fill depletes the book, the NEXT estimate is worse (depth-aware)
const impact = new E.ImpactBook(() => 0, 5000);
const raw = { asks: ladder(100, 0.01, 10, 1), bids: ladder(99.99, -0.01, 10, 1) };
const live = { price: { X: 100 }, depth: () => impact.adjust('X', raw), consume: (s, sd, t) => impact.consume(s, sd, t), bid: () => 99.99, ask: () => (live.depth().asks[0] ?? [101])[0] };
const first = S.estimateSlippage(live, 'X', 'BUY', 3);
new E.Account().submit(live, { sym: 'X', side: 'BUY', type: 'MKT', qty: 3 }); // eats 3 levels
const second = S.estimateSlippage(live, 'X', 'BUY', 3);
assert(second.avg > first.avg, 'second order sees a worse price'); assert(second.share > first.share, 'and a bigger share of what is left');

// 12) one-line summary for the command line
assert(/est\. slippage 50\.\d bps: Walks 3 book levels/.test(S.slippageLine(S.estimateSlippage(deep(0.5), 'X', 'BUY', 3000))));
assert.strictEqual(S.slippageLine(S.estimateSlippage(book(), 'X', 'BUY', 0.5)), 'est. slippage 0.0 bps');

console.log('slippage tests passed');
