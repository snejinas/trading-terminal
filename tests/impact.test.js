const E = require('../.test-build/engine.js');
const assert = require('assert');
const near = (a, b, m) => assert(Math.abs(a - b) < 1e-9, `${m}: ${a} vs ${b}`);

// A feed over a fixed raw book, with our ImpactBook overlay and a fake clock.
function feed(raw) {
  let t = 0;
  const impact = new E.ImpactBook(() => t, 5000);
  const f = {
    price: { X: 100 }, raw,
    depth: () => impact.adjust('X', f.raw),
    consume: (s, side, taken) => impact.consume(s, side, taken),
    bid: () => (f.depth().bids[0] ?? [99])[0],
    ask: () => (f.depth().asks[0] ?? [101])[0],
    advance: ms => { t += ms; }, has: () => impact.has('X'),
  };
  return f;
}
const RAW = () => ({ asks: [[100.1, 1], [100.2, 2], [100.5, 10]], bids: [[100, 1], [99.9, 2], [99.5, 10]] });

// 1) second order immediately after the first sees depleted liquidity
let m = feed(RAW()), a = new E.Account();
assert.strictEqual(a.submit(m, { sym: 'X', side: 'BUY', type: 'MKT', qty: 2.5 }), null); // eats 100.1x1 + 100.2x1.5
assert.deepStrictEqual(m.depth().asks.map(l => [l[0], +l[1].toFixed(9)]), [[100.2, 0.5], [100.5, 10]]);
assert.strictEqual(m.ask(), 100.2, 'touch moves up once the top level is gone');
assert.strictEqual(a.submit(m, { sym: 'X', side: 'BUY', type: 'MKT', qty: 1 }), null);
let f = a.fills[0];
near(f.price, (0.5 * 100.2 + 0.5 * 100.5) / 1, 'second fill vwap'); assert.strictEqual(f.levels, 2);
// without depletion the same second order would have been cheaper: 1 @ 100.1 first level was already gone
assert(f.price > 100.1 + 0.2);

// 2) the bid side is untouched by a buy
assert.deepStrictEqual(m.depth().bids, RAW().bids);

// 3) liquidity recovers: after one half-life half the consumed size is back, later fully
m = feed(RAW()); a = new E.Account();
a.submit(m, { sym: 'X', side: 'BUY', type: 'MKT', qty: 3 }); // asks 100.1 and 100.2 fully consumed
assert.deepStrictEqual(m.depth().asks.map(l => l[0]), [100.5, ]);
m.advance(5000); // half-life
let asks = m.depth().asks; near(asks[0][0], 100.1, 'level returns'); near(asks[0][1], 0.5, 'half recovered');
near(asks[1][1], 1, 'level 2: 2 consumed -> 1 back');
m.advance(5000 * 40);
assert.deepStrictEqual(m.depth(), RAW(), 'fully recovered');
assert(!m.has(), 'impact inactive after recovery');

// 4) fully consuming all visible liquidity means a market order is rejected, never "infinite" liquidity
m = feed({ asks: [[100.1, 1]], bids: [[100, 1]] }); a = new E.Account();
assert.strictEqual(a.submit(m, { sym: 'X', side: 'BUY', type: 'MKT', qty: 1 }), null);
assert.deepStrictEqual(m.depth().asks, []);
const err = a.submit(m, { sym: 'X', side: 'BUY', type: 'MKT', qty: 0.01 });
assert(/visible liquidity/.test(err), String(err));
assert.strictEqual(a.fills.length, 1);

// 5) consumption is keyed by price: if the market moves, old consumption doesn't haunt the new levels
m = feed(RAW()); a = new E.Account();
a.submit(m, { sym: 'X', side: 'BUY', type: 'MKT', qty: 3 });
m.raw = { asks: [[101.0, 1], [101.1, 1]], bids: [[100.9, 1]] }; // market moved
assert.deepStrictEqual(m.depth(), m.raw);

// 6) maker fills do NOT deplete the book (someone else hit our resting order)
m = feed(RAW()); a = new E.Account();
a.submit(m, { sym: 'X', side: 'BUY', type: 'LMT', qty: 1, limit: 99 }); // rests
m.raw = { asks: [[98, 5]], bids: [[97, 5]] };
a.match(m); assert.strictEqual(a.fills[0].role, 'maker'); assert.deepStrictEqual(m.depth(), m.raw, 'book untouched by maker fill');

// 7) a marketable limit's crossing part (taker) depletes; only the filled part
m = feed(RAW()); a = new E.Account();
a.submit(m, { sym: 'X', side: 'BUY', type: 'LMT', qty: 5, limit: 100.2 }); // takes 100.1x1 + 100.2x2, rests 2
assert.deepStrictEqual(m.depth().asks.map(l => l[0]), [100.5]);
assert.strictEqual(a.orders[0].qty, 2);
// ...and the resting remainder is now NOT immediately re-filled against liquidity we just ate
a.match(m); assert.strictEqual(a.orders[0].qty, 2, 'remainder stays resting; limit 100.2 has no liquidity left');

// 8) selling depletes bids, symmetrically
m = feed(RAW()); a = new E.Account();
assert.strictEqual(a.submit(m, { sym: 'X', side: 'BUY', type: 'MKT', qty: 2 }), null);
m.advance(5000 * 40);
assert.strictEqual(a.submit(m, { sym: 'X', side: 'SELL', type: 'MKT', qty: 1.5 }), null);
assert.deepStrictEqual(m.depth().bids.map(l => [l[0], +l[1].toFixed(9)]), [[99.9, 1.5], [99.5, 10]]);

// 9) no depth feed (sim): unlimited top-of-book, consume() absent, nothing breaks
a = new E.Account();
assert.strictEqual(a.submit({ price: { X: 100 }, bid: () => 99.99, ask: () => 100.01 }, { sym: 'X', side: 'BUY', type: 'MKT', qty: 500 }), null);

console.log('impact tests passed');
