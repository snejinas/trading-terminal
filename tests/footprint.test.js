// Order flow footprint: aggressor split, per-minute storage, de-duplication, regrouping into rows, imbalances, formatting.
const assert = require('assert');
const F = require('../.test-build/footprint.js');
const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));
const M = 60000;
const T = (id, t, p, q, m) => ({ id, t, p, q, m });

// ---- aggressor: buyer-is-maker means the seller hit the bid ----
let st = F.createFlowStore(0.5);
F.addTrade(st, T(1, 5 * M + 100, 100.0, 2, false), 'live');     // buyer aggressor -> bought at the ask
F.addTrade(st, T(2, 5 * M + 200, 100.0, 3, true), 'live');      // seller aggressor -> sold at the bid
F.addTrade(st, T(3, 5 * M + 300, 100.2, 1, false), 'live');     // 100.2 rounds to the 100.0 level (tick 0.5)
const lv = st.minutes.get(5 * M);
assert.strictEqual(lv.size, 1); assert.deepStrictEqual(lv.get(200), { b: 3, s: 3 });
assert.strictEqual(st.trades, 3); assert.strictEqual(st.minId, 1); assert.strictEqual(st.maxId, 3); assert.strictEqual(st.firstT, 5 * M + 100); assert.strictEqual(st.lastT, 5 * M + 300);
// minutes are separate
F.addTrade(st, T(4, 6 * M, 101, 4, false), 'live'); assert.strictEqual(st.minutes.size, 2); assert.deepStrictEqual(st.minutes.get(6 * M).get(202), { b: 4, s: 0 });

// ---- de-duplication between the live stream and the backfill ----
st = F.createFlowStore(1);
assert(F.addTrade(st, T(100, 1000, 50, 1, false), 'live'));
assert(!F.addTrade(st, T(100, 1000, 50, 1, false), 'live'), 'same id again');
assert(!F.addTrade(st, T(99, 1000, 50, 1, false), 'live'), 'a live trade must be newer');
assert(F.addTrade(st, T(101, 1000, 50, 1, false), 'live'));
assert(F.addTrade(st, T(99, 900, 50, 1, true), 'history'), 'history older than everything held');
assert(!F.addTrade(st, T(100, 1000, 50, 1, false), 'history'), 'history overlapping what live already counted');
assert(!F.addTrade(st, T(150, 1000, 50, 1, false), 'history'), 'history must be older');
assert(F.addTrade(st, T(98, 800, 50, 1, true), 'history'));
assert.strictEqual(st.trades, 4); assert.strictEqual(st.minId, 98); assert.strictEqual(st.maxId, 101);
// an empty store accepts either kind first
assert(F.addTrade(F.createFlowStore(1), T(7, 1, 5, 1, false), 'history'));
// bad trades are ignored
st = F.createFlowStore(1);
for (const bad of [T(1, 0, 5, 0, false), T(1, 0, 5, -1, false), T(1, 0, 5, NaN, false), T(1, 0, 0, 1, false), T(1, 0, NaN, 1, false), T(NaN, 0, 5, 1, false), T(1, NaN, 5, 1, false), T(1, 0, -3, 1, false)]) assert(!F.addTrade(st, bad, 'live'));
assert.strictEqual(st.trades, 0);

// ---- retention ----
st = F.createFlowStore(1);
F.addTrade(st, T(1, 10 * M, 50, 1, false), 'live');
F.addTrade(st, T(2, 10 * M + F.FLOW_RETENTION_MS + 5 * M, 50, 1, false), 'live');         // far newer: the first minute falls out
assert(!st.minutes.has(10 * M)); assert.strictEqual(st.minutes.size, 1);
assert(!F.addTrade(st, T(0, 10 * M, 50, 1, false), 'history'), 'history older than the retention window is not kept');
st = F.createFlowStore(1);
F.addTrade(st, T(5, 100 * M, 50, 1, false), 'live'); assert(F.addTrade(st, T(4, 100 * M - 3 * 60 * M, 50, 1, true), 'history'), 'within four hours is kept');

// ---- regrouping into a candle and rows ----
st = F.createFlowStore(0.5);
const base = 20 * M;
[[1, 0, 100.0, 1, false], [2, 1000, 100.0, 2, true], [3, 2000, 100.5, 4, false], [4, 3000, 101.0, 1, true], [5, 4000, 102.5, 3, false], [6, M + 500, 100.0, 5, true], [7, 2 * M, 100.5, 7, false]]
  .forEach(([id, dt, p, q, m]) => F.addTrade(st, T(id, base + dt, p, q, m), 'live'));
// a 1-minute candle with rows of 1.0: [100,101) holds 100.0 and 100.5, [101,102) holds 101.0, [102,103) holds 102.5
let fp = F.footprintOf(st, base, M, 1);
assert.deepStrictEqual(fp.levels.map((l) => [l.k, l.price, l.b, l.s]), [[102, 102, 3, 0], [101, 101, 0, 1], [100, 100, 5, 2]]);
assert.strictEqual(fp.buy, 8); assert.strictEqual(fp.sell, 3); assert.strictEqual(fp.delta, 5); assert.strictEqual(fp.pocK, 100);
// finer rows split them again; the totals do not change
fp = F.footprintOf(st, base, M, 0.5);
assert.deepStrictEqual(fp.levels.map((l) => [l.price, l.b, l.s]), [[102.5, 3, 0], [101, 0, 1], [100.5, 4, 0], [100, 1, 2]]); assert.strictEqual(fp.buy + fp.sell, 11);
// a three-minute candle merges the minutes
fp = F.footprintOf(st, base, 3 * M, 1);
assert.strictEqual(fp.buy, 15); assert.strictEqual(fp.sell, 8); assert.deepStrictEqual(fp.levels.find((l) => l.k === 100), { k: 100, price: 100, b: 12, s: 7 });
assert.strictEqual(fp.pocK, 100);
// a candle with no trades, and times that do not fall on a minute
assert.strictEqual(F.footprintOf(st, base + 10 * M, M, 1), null);
assert.strictEqual(F.footprintOf(F.createFlowStore(1), base, M, 1), null);
assert.strictEqual(F.footprintOf(st, base + 1234, M, 1) !== null, true, 'a candle start between minute boundaries still finds its minute');
// ties for the point of control go to the higher price
st = F.createFlowStore(1); F.addTrade(st, T(1, 0, 10, 5, false), 'live'); F.addTrade(st, T(2, 1, 20, 5, true), 'live');
assert.strictEqual(F.footprintOf(st, 0, M, 1).pocK, 20);
// rounding: a price just below a row edge stays in the row below (no floating-point drift into the next one)
st = F.createFlowStore(0.01); F.addTrade(st, T(1, 0, 68000.1, 1, false), 'live'); F.addTrade(st, T(2, 1, 68000.0, 1, false), 'live'); F.addTrade(st, T(3, 2, 67999.99, 1, false), 'live');
assert.deepStrictEqual(F.footprintOf(st, 0, M, 0.1).levels.map((l) => [Math.round(l.price * 10) / 10, l.b]), [[68000.1, 1], [68000, 1], [67999.9, 1]]);
assert.deepStrictEqual(F.footprintOf(st, 0, M, 1).levels.map((l) => [l.price, l.b]), [[68000, 2], [67999, 1]]);

// ---- nice steps ----
for (const [raw, want] of [[0.3, 0.5], [0.5, 0.5], [0.51, 1], [1, 1], [1.01, 2], [2.2, 2.5], [2.6, 5], [5.1, 10], [7, 10], [13, 20], [0.00031, 0.0005], [450, 500], [1e-9, 1e-9]]) assert(close(F.niceStep(raw), want), `${raw} -> ${F.niceStep(raw)} (want ${want})`);
for (const bad of [0, -1, NaN, Infinity]) assert.strictEqual(F.niceStep(bad), 1);
for (let x = 0.01; x < 1e5; x *= 1.37) { const n = F.niceStep(x); assert(n >= x - 1e-12 && n < x * 2.6, `${x} -> ${n}`); }

// ---- imbalances ----
const L = (k, b, s) => ({ k, price: k, b, s });
// rows from high to low: 105 (buy 9), 104 (sell 4 / buy 0), 103 (buy 6 / sell 1), 102 (sell 9)
let im = F.imbalances([L(105, 9, 0), L(104, 0, 4), L(103, 6, 1), L(102, 0, 9)], 3);
// buy imbalance at k when b >= 3 x (sold one row lower): 105 vs 104.s=4: 9 < 12 no; 103 vs 102.s=9: 6 < 27 no
// sell imbalance at k when s >= 3 x (bought one row higher): 104 vs 105.b=9: 4 < 27 no; 102 vs 103.b=6: 9 < 18 no; 103 vs 104.b=0: 1 >= 0 yes
assert.deepStrictEqual(im, [[false, false], [false, false], [false, true], [false, false]]);
im = F.imbalances([L(105, 9, 0), L(104, 0, 2)], 3); assert.deepStrictEqual(im[0], [true, false]);      // 9 >= 3 x 2
assert.deepStrictEqual(F.imbalances([L(10, 1, 0), L(8, 0, 5)], 3), [[true, false], [false, true]], 'rows that are not adjacent have no neighbour: any volume counts as an imbalance');
assert.deepStrictEqual(F.imbalances([L(10, 0, 0)], 3), [[false, false]], 'no volume, no imbalance');
assert.deepStrictEqual(F.imbalances([], 3), []);
assert.deepStrictEqual(F.imbalances([L(5, 3, 0), L(4, 0, 1)], 3)[0], [true, false], 'exactly the ratio counts');
assert.deepStrictEqual(F.imbalances([L(5, 2.9, 0), L(4, 0, 1)], 3)[0], [false, false]);

// ---- formatting ----
for (const [v, s] of [[0, '·'], [-1, '·'], [NaN, '·'], [Infinity, '·'], [0.0004, '.000'], [0.004, '.004'], [0.0456, '0.05'], [0.5, '0.50'], [3.214, '3.21'], [12.34, '12.3'], [99.96, '100.0'], [100, '100'], [999.4, '999'], [1234, '1.2K'], [9999, '10.0K'], [12400, '12K'], [250000, '250K']]) {
  const out = F.fmtFlow(v); if (v === 99.96) assert(['100.0', '100'].includes(out), out); else if (v === 9999) assert(['10.0K', '10K'].includes(out), out); else assert.strictEqual(out, s, `${v}`);
}
for (let v = 0.001; v < 1e6; v *= 1.9) assert(F.fmtFlow(v).length <= 5, `${v} -> ${F.fmtFlow(v)}`);

// ---- coverage and settings ----
assert.deepStrictEqual(F.flowCoverage(null), { trades: 0, firstT: null, lastT: null }); assert.deepStrictEqual(F.flowCoverage(F.createFlowStore(1)), { trades: 0, firstT: null, lastT: null });
st = F.createFlowStore(1); F.addTrade(st, T(1, 50, 5, 1, false), 'live'); F.addTrade(st, T(2, 90, 5, 1, false), 'live'); assert.deepStrictEqual(F.flowCoverage(st), { trades: 2, firstT: 50, lastT: 90 });
const mem = {};
global.window = { localStorage: { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); } } };
assert.strictEqual(F.loadFootprintPref(), false); F.saveFootprintPref(true); assert.strictEqual(F.loadFootprintPref(), true); F.saveFootprintPref(false); assert.strictEqual(F.loadFootprintPref(), false);
global.window = { localStorage: { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); } } };
assert.strictEqual(F.loadFootprintPref(), false); F.saveFootprintPref(true); delete global.window;

// ---- speed: a busy hour of trading, regrouped for a visible window ----
let seed = 9; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const big = F.createFlowStore(0.01);
for (let i = 0; i < 200000; i++) F.addTrade(big, T(i + 1, 1000 * M + Math.floor((i / 200000) * 180 * M), 68000 + Math.round((rnd() - 0.5) * 6000) / 100, rnd(), rnd() < 0.5), 'live');
const t0 = process.hrtime.bigint();
for (let c = 0; c < 90; c++) F.footprintOf(big, 1000 * M + (90 + c) * M, M, 1);
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
assert(ms < 200, `90 candles regrouped in ${ms.toFixed(0)}ms`);
console.log('footprint: ok');
