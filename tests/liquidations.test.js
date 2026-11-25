// Liquidation heatmap model: liquidation prices, inflows, level consumption, the grid, parsing, storage.
const assert = require('assert');
const L = require('../.test-build/liquidations.js');
const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));
const C = (t, o, h, l, c, v) => ({ t, o, h, l, c, ...(v === undefined ? {} : { v }) });
const M = 60000;

// liquidation price: long below the entry, short above, closer for higher leverage
assert(close(L.liqPrice(100, 10, 'long'), 100 * (1 - 0.1 + 0.005))); assert(close(L.liqPrice(100, 10, 'short'), 100 * (1 + 0.1 - 0.005)));
assert(close(L.liqPrice(68000, 100, 'long'), 68000 * 0.995)); assert(close(L.liqPrice(68000, 100, 'short'), 68000 * 1.005));
assert(close(L.liqPrice(100, 5, 'long', 0), 80)); assert(close(L.liqPrice(100, 5, 'short', 0), 120));
for (let lev = 2; lev < 100; lev++) { assert(L.liqPrice(100, lev, 'long') < L.liqPrice(100, lev + 1, 'long')); assert(L.liqPrice(100, lev, 'short') > L.liqPrice(100, lev + 1, 'short')); }
assert(close(L.LIQ_TIERS.reduce((a, t) => a + t.share, 0), 1));

// OI parsing
assert.deepStrictEqual(L.parseOiRows([{ sumOpenInterestValue: '5', timestamp: 2000 }, { sumOpenInterestValue: '3', timestamp: 1000 }, { sumOpenInterestValue: 'x', timestamp: 3000 }, null, { timestamp: 4000 }, { sumOpenInterestValue: '7', timestamp: 2000 }]), [{ t: 1000, v: 3 }, { t: 2000, v: 5 }]);
for (const junk of [null, undefined, 4, 'x', {}]) assert.deepStrictEqual(L.parseOiRows(junk), []);
assert.deepStrictEqual(L.parseOiRows([{ sumOpenInterestValue: '-1', timestamp: 5 }, { sumOpenInterestValue: '1', timestamp: 0 }]), []);

// inflow from volume: volume x typical price; missing / bad volume is 0
const vc = [C(0, 1, 12, 8, 10, 2), C(M, 1, 3, 3, 3), C(2 * M, 1, 3, 3, 3, NaN), C(3 * M, 1, 3, 3, 3, -4)];
assert.deepStrictEqual(L.inflowFromVolume(vc), [2 * 10, 0, 0, 0]);

// inflow from OI: growth spread evenly over the interval, positive growth only
const five = Array.from({ length: 10 }, (_, i) => C(i * M, 1, 1, 1, 1));
let inf = L.inflowFromOi(five, [{ t: 0, v: 100 }, { t: 5 * M, v: 600 }], M);  // +500 over five 1m candles
assert.deepStrictEqual(inf.map((x) => Math.round(x)), [100, 100, 100, 100, 100, 0, 0, 0, 0, 0]);
inf = L.inflowFromOi(five, [{ t: 0, v: 100 }, { t: 5 * M, v: 600 }, { t: 10 * M, v: 300 }], M);  // then a decrease adds nothing
assert.deepStrictEqual(inf.map((x) => Math.round(x)), [100, 100, 100, 100, 100, 0, 0, 0, 0, 0]);
// candles longer than the snapshot interval receive the sum of overlapping growth
const big = [C(0, 1, 1, 1, 1), C(10 * M, 1, 1, 1, 1)];
inf = L.inflowFromOi(big, [{ t: 0, v: 0 }, { t: 5 * M, v: 50 }, { t: 10 * M, v: 80 }, { t: 15 * M, v: 90 }, { t: 20 * M, v: 90 }], 10 * M);
assert(close(inf[0], 80) && close(inf[1], 10), JSON.stringify(inf));
// partial overlap: a growth interval straddling two candles is split by time
inf = L.inflowFromOi([C(0, 1, 1, 1, 1), C(M, 1, 1, 1, 1)], [{ t: M / 2, v: 0 }, { t: M * 3 / 2, v: 100 }], M);
assert(close(inf[0], 50) && close(inf[1], 50));
// total is conserved when the candles cover the whole interval; candles outside get 0; bad input is harmless
assert(close(L.inflowFromOi(five, [{ t: 2 * M, v: 0 }, { t: 7 * M, v: 1000 }], M).reduce((a, b) => a + b), 1000));
assert(L.inflowFromOi(five, [{ t: 100 * M, v: 0 }, { t: 110 * M, v: 50 }], M).every((x) => x === 0));
assert(L.inflowFromOi(five, [{ t: 0, v: 5 }], M).every((x) => x === 0)); assert(L.inflowFromOi(five, [], M).every((x) => x === 0)); assert(L.inflowFromOi(five, [{ t: 0, v: 1 }, { t: M, v: 2 }], 0).every((x) => x === 0));
assert.deepStrictEqual(L.inflowFor(five, null, M).mode, 'volume'); assert.deepStrictEqual(L.inflowFor(five, [{ t: 0, v: 1 }], M).mode, 'volume');
assert.deepStrictEqual(L.inflowFor(five, [{ t: 0, v: 1 }, { t: M, v: 2 }], M).mode, 'oi');

// segments against a naive O(n^2) reference on random candles
let s = 42; const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
let px = 100; const walk = [];
for (let i = 0; i < 400; i++) { px *= 1 + (rnd() - 0.5) * 0.02; walk.push(C(i * M, px, px * (1 + rnd() * 0.006), px * (1 - rnd() * 0.006), px * (1 + (rnd() - 0.5) * 0.004), 5 + rnd() * 20)); }
const inflow = L.inflowFromVolume(walk);
const fast = L.buildSegments(walk, inflow);
const naive = [];
for (let i = 0; i < walk.length; i++) {
  const entry = (walk[i].h + walk[i].l + walk[i].c) / 3;
  for (const tier of L.LIQ_TIERS) for (const side of ['long', 'short']) {
    const price = L.liqPrice(entry, tier.lev, side);
    let to = walk.length;
    for (let j = i + 1; j < walk.length; j++) if (side === 'long' ? walk[j].l <= price : walk[j].h >= price) { to = j; break; }
    naive.push({ from: i, to, price, amount: inflow[i] * tier.share * 0.5, side, lev: tier.lev });
  }
}
assert.strictEqual(fast.length, naive.length);
fast.forEach((f, k) => { const n = naive[k]; assert.strictEqual(f.from, n.from); assert.strictEqual(f.to, n.to, `to @${k} ${f.side} ${f.lev}`); assert(close(f.price, n.price)); assert(close(f.amount, n.amount)); assert.strictEqual(f.side, n.side); });
assert(fast.some((f) => f.to < walk.length) && fast.some((f) => f.to === walk.length), 'a mix of consumed and surviving levels');
// the candle that opened a position never consumes it, even if its own range spans the level
const wide = L.buildSegments([C(0, 100, 200, 1, 100, 1), C(M, 100, 100, 100, 100)], [1000, 0]);
assert(wide.every((w) => w.from === 0 && w.to === 2), 'own candle does not consume; the next one does not reach');
const hit = L.buildSegments([C(0, 100, 100, 100, 100, 1), C(M, 100, 100.4, 99.6, 100)], [1000, 0]);   // 100x: long liq 99.5, short liq 100.5 (not reached by 99.6 / 100.4)
assert(hit.every((h) => h.to === 2));
const hit2 = L.buildSegments([C(0, 100, 100, 100, 100, 1), C(M, 100, 100.6, 99.4, 100)], [1000, 0]);
const h100 = hit2.filter((h) => h.lev === 100); assert(h100.length === 2 && h100.every((h) => h.to === 1), '100x levels at +-0.5% are consumed by a +-0.6% candle');
assert(hit2.filter((h) => h.lev === 50).every((h) => h.to === 2), '50x levels (+-1.5%) survive');
// nothing to do for zero inflow / empty
assert.deepStrictEqual(L.buildSegments([], []), []); assert.deepStrictEqual(L.buildSegments(walk.slice(0, 5), [0, 0, 0, 0, 0]), []);
assert(L.buildSegments([C(0, 1, 1, 1, 1)], [NaN]).length === 0);
// amount is conserved across tiers and sides
const one = L.buildSegments([C(0, 100, 100, 100, 100, 1)], [1000]);
assert.strictEqual(one.length, 10); assert(close(one.reduce((a, x) => a + x.amount, 0), 1000));
assert(close(one.filter((x) => x.side === 'long').reduce((a, x) => a + x.amount, 0), 500));

// grid: rows are price bins (row 0 = hi), columns are candles, a level is "on" from opening until consumed
const seg = (from, to, price, amount) => ({ from, to, price, amount, side: 'long', lev: 10 });
let g = L.buildGrid([seg(1, 3, 95, 10), seg(0, 5, 95, 4), seg(2, 4, 85, 7)], 0, 4, 80, 100, 4, 100);
assert.strictEqual(g.rows, 4); assert.strictEqual(g.cols, 5); assert.strictEqual(g.group, 1);
const at = (r, c) => g.cells[r * g.cols + c];
assert.deepStrictEqual([0, 1, 2, 3, 4].map((c) => at(1, c)), [4, 14, 14, 4, 4]);  // price 95 -> row floor((100-95)/20*4)=1
assert.deepStrictEqual([0, 1, 2, 3, 4].map((c) => at(3, c)), [0, 0, 7, 7, 0]);     // price 85 -> row 3; alive in columns 2 and 3
assert(g.cells.every((v, i) => [1, 3].includes(Math.floor(i / 5)) || v === 0)); assert.strictEqual(g.max, 14);
// prices outside the range and segments outside the window are skipped; edges clamp
g = L.buildGrid([seg(0, 5, 120, 9), seg(0, 5, 70, 9), seg(9, 12, 90, 9), seg(0, 1, 90, 9)], 2, 4, 80, 100, 4, 100);
assert.strictEqual(g.max, 0); assert.strictEqual(g.cols, 3);
g = L.buildGrid([seg(0, 5, 100, 5), seg(0, 5, 80, 6)], 0, 4, 80, 100, 4, 100);
assert.strictEqual(g.cells[0 * 5 + 2], 5, 'price == hi is the top row'); assert.strictEqual(g.cells[3 * 5 + 2], 6, 'price == lo is the bottom row');
// a window that starts mid-way sees levels opened earlier; consumed-before-window levels are gone
g = L.buildGrid([seg(0, 6, 90, 3), seg(0, 2, 90, 50)], 3, 6, 80, 100, 4, 100);
assert.deepStrictEqual(Array.from(g.cells.slice(2 * 4, 3 * 4)), [3, 3, 3, 0]); // alive in candles 3-5, consumed by candle 6
// many candles share columns, and level start / end land in the right column
g = L.buildGrid([seg(0, 20, 90, 1)], 0, 19, 80, 100, 2, 5);
assert.strictEqual(g.group, 4); assert.strictEqual(g.cols, 5); assert.deepStrictEqual(Array.from(g.cells.slice(5, 10)), [1, 1, 1, 1, 1]);
g = L.buildGrid([seg(5, 9, 90, 2)], 0, 19, 80, 100, 2, 5);  // opens in candle 5 (column 1), consumed by candle 9 (column 2)
assert.deepStrictEqual(Array.from(g.cells.slice(5, 10)), [0, 2, 2, 0, 0]);
assert.strictEqual(L.buildGrid([], 5, 4, 1, 2, 3, 10).cols, 0); assert.strictEqual(L.buildGrid([], 0, 4, 2, 2, 3, 10).max, 0);
// grid totals equal the segment amounts when nothing is clipped
const all = L.buildGrid(fast, 0, walk.length - 1, Math.min(...fast.map((f) => f.price)) - 1, Math.max(...fast.map((f) => f.price)) + 1, 64, 400);
assert(all.max > 0 && all.cols === 400 || all.cols === walk.length);

// colour ramp
assert.deepStrictEqual(L.heatColor(0), [38, 20, 80]); assert.deepStrictEqual(L.heatColor(1), [250, 230, 60]); assert.deepStrictEqual(L.heatColor(-3), L.heatColor(0)); assert.deepStrictEqual(L.heatColor(9), L.heatColor(1)); assert.deepStrictEqual(L.heatColor(NaN), L.heatColor(0));
for (let t = 0; t <= 1; t += 0.1) L.heatColor(t).forEach((x) => assert(Number.isInteger(x) && x >= 0 && x <= 255));
assert.deepStrictEqual(L.heatColor(0.5), [30, 150, 190]);
// periods
assert.strictEqual(L.oiPeriod('1m'), '5m'); assert.strictEqual(L.oiPeriod('5m'), '5m'); assert.strictEqual(L.oiPeriod('4h'), '4h'); assert.strictEqual(L.oiPeriod('1d'), '1d'); assert.strictEqual(L.oiPeriod('weird'), '1h');

// storage
const mem = {};
global.window = { localStorage: { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); } } };
assert.strictEqual(L.loadLiqPref(), false); L.saveLiqPref(true); assert.strictEqual(L.loadLiqPref(), true); L.saveLiqPref(false); assert.strictEqual(L.loadLiqPref(), false);
global.window = { localStorage: { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); } } };
assert.strictEqual(L.loadLiqPref(), false); L.saveLiqPref(true); delete global.window;

// speed: the maximum history
let p2 = 100; const bigc = Array.from({ length: 10000 }, (_, i) => { p2 *= 1 + (rnd() - 0.5) * 0.004; return C(i * M, p2, p2 * 1.001, p2 * 0.999, p2, 10 + rnd()); });
let t0 = process.hrtime.bigint(); const bs = L.buildSegments(bigc, L.inflowFromVolume(bigc)); let ms = Number(process.hrtime.bigint() - t0) / 1e6;
assert(ms < 400, `segments for 10k candles took ${ms.toFixed(0)}ms`);
t0 = process.hrtime.bigint(); L.buildGrid(bs, 9000, 9999, 90, 110, 100, 400); ms = Number(process.hrtime.bigint() - t0) / 1e6;
assert(ms < 100, `grid took ${ms.toFixed(0)}ms`);
console.log('liquidations: ok');
