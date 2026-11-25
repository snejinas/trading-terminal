// Volume profile: spreading volume over price levels, point of control, value area, settings.
const assert = require('assert');
const V = require('../.test-build/volumeprofile.js');
const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));
const C = (l, h, v, t = 0) => ({ t, o: l, h, l, c: h, ...(v === undefined ? {} : { v }) });
const arr = (b) => Array.from(b);

// ---- spreading: range [0, 40] in 4 levels of 10; bin 0 is the top ----
let p = V.volumeProfile([C(10, 20, 100)], 0, 40, 4);
assert.deepStrictEqual(arr(p.bins), [0, 0, 100, 0]); assert.strictEqual(p.total, 100); assert.strictEqual(p.rows, 4);
p = V.volumeProfile([C(15, 25, 100)], 0, 40, 4);
assert.deepStrictEqual(arr(p.bins), [0, 50, 50, 0]);
p = V.volumeProfile([C(5, 35, 300)], 0, 40, 4);                      // 30 wide: 5 + 10 + 10 + 5 over four levels
assert.deepStrictEqual(arr(p.bins).map((x) => Math.round(x * 1e6) / 1e6), [50, 100, 100, 50]);
p = V.volumeProfile([C(12.5, 12.5, 7)], 0, 40, 4); assert.deepStrictEqual(arr(p.bins), [0, 0, 7, 0]);   // no range: one level
p = V.volumeProfile([C(40, 40, 3), C(0, 0, 5)], 0, 40, 4);                                              // on the edges
assert.deepStrictEqual(arr(p.bins), [3, 0, 0, 5]);
p = V.volumeProfile([C(20, 20, 4), C(30, 30, 6)], 0, 40, 4);                                            // exactly on a level boundary: the lower level (price is the bin's top edge)
assert.strictEqual(p.total, 10);
// several candles add up
p = V.volumeProfile([C(10, 20, 100), C(10, 20, 50), C(30, 40, 10)], 0, 40, 4); assert.deepStrictEqual(arr(p.bins), [10, 0, 150, 0]);

// ---- volume that cannot be placed ----
p = V.volumeProfile([C(10, 20, undefined), C(10, 20, 0), C(10, 20, -5), C(10, 20, NaN), C(10, 20, Infinity), { t: 0, o: 1, h: NaN, l: 1, c: 1, v: 5 }], 0, 40, 4); assert.strictEqual(p.total, 0);
p = V.volumeProfile([C(50, 60, 100), C(-20, -10, 100)], 0, 40, 4); assert.strictEqual(p.total, 0);       // entirely outside
p = V.volumeProfile([C(30, 50, 100)], 0, 40, 4);                                                         // half outside: that half is lost
assert(close(p.total, 50)); assert.deepStrictEqual(arr(p.bins).map((x) => Math.round(x * 1e6) / 1e6), [50, 0, 0, 0]);   // the 30-40 half, all in the top level
for (const [lo, hi, rows] of [[10, 10, 4], [10, 5, 4], [0, 10, 0], [0, 10, -3], [0, 10, 2.5], [0, 10, NaN], [NaN, 10, 4]]) { const q = V.volumeProfile([C(1, 2, 5)], lo, hi, rows); assert.strictEqual(q.total, 0, `${lo},${hi},${rows}`); assert(q.bins.every((x) => x === 0)); }
assert.strictEqual(V.volumeProfile([], 0, 10, 5).total, 0);
// a candle given with high < low is read as its range
p = V.volumeProfile([{ t: 0, o: 1, h: 10, l: 20, c: 15, v: 100 }], 0, 40, 4); assert.deepStrictEqual(arr(p.bins), [0, 0, 100, 0]);

// ---- against a naive reference on random candles ----
let s = 3; const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
const cs = Array.from({ length: 500 }, (_, i) => { const m = 100 + (rnd() - 0.5) * 40, w = rnd() * 3; return { t: i, o: m, h: m + w, l: m - w, c: m, v: rnd() * 50 }; });
const lo = Math.min(...cs.map((c) => c.l)) - 1, hi = Math.max(...cs.map((c) => c.h)) + 1;
for (const rows of [1, 7, 48, 200]) {
  const got = V.volumeProfile(cs, lo, hi, rows), bw = (hi - lo) / rows;
  const want = new Array(rows).fill(0);
  for (const c of cs) for (let r = 0; r < rows; r++) { const bt = hi - r * bw, bb = bt - bw; const ov = Math.min(c.h, bt) - Math.max(c.l, bb); if (ov > 0) want[r] += c.v * ov / (c.h - c.l); }
  got.bins.forEach((x, r) => assert(close(x, want[r], 1e-9), `rows ${rows} bin ${r}: ${x} vs ${want[r]}`));
  assert(close(got.total, cs.reduce((a, c) => a + c.v, 0), 1e-9), `conserved with ${rows} rows`);
}

// ---- point of control and value area ----
const prof = (bins) => ({ rows: bins.length, lo: 0, hi: bins.length * 10, bins: Float64Array.from(bins), total: bins.reduce((a, b) => a + b, 0) });
let st = V.profileStats(prof([1, 2, 10, 3, 4, 1]), 0.7);                   // total 21, need 14.7
assert.strictEqual(st.pocRow, 2); assert.strictEqual(st.pocVolume, 10); assert(close(st.pocPrice, 60 - 25));      // row 2 spans [30, 40]; hi = 60
assert.strictEqual(st.vahRow, 2); assert.strictEqual(st.valRow, 4);        // 10 -> +3 (below, > 2 above) = 13 -> +4 = 17 >= 14.7
assert(close(st.vaVolume, 17)); assert(close(st.vah, 40)); assert(close(st.val, 10));
// grows towards the busier neighbour; ties go up
st = V.profileStats(prof([5, 5, 20, 5, 5]), 0.7);   // total 40, need 28: 20 -> +5 (up, tie) = 25 -> +5 (above 5 vs below 5, up) = 30
assert.strictEqual(st.vahRow, 0); assert.strictEqual(st.valRow, 2); assert(close(st.vaVolume, 30));
// the busiest level wins; a tie goes to the higher price (lower row)
assert.strictEqual(V.profileStats(prof([1, 9, 3, 9, 1]), 0.5).pocRow, 1);
// all volume in one level: that level is the whole area
st = V.profileStats(prof([0, 0, 8, 0]), 0.7); assert.strictEqual(st.vahRow, 2); assert.strictEqual(st.valRow, 2);
// the whole profile at 100%; an edge that runs out grows the other way
st = V.profileStats(prof([9, 1, 1, 1]), 1); assert.strictEqual(st.pocRow, 0); assert.strictEqual(st.valRow, 3); assert(close(st.vaVolume, 12));
st = V.profileStats(prof([9, 2, 0, 0]), 0.95); assert.strictEqual(st.valRow, 1); assert(close(st.vaVolume, 11));     // stops once 95% is covered
// monotone: a larger share never shrinks the area, and it always holds at least the share
const big = V.volumeProfile(cs, lo, hi, 60); let prev = 0;
for (const f of [0.5, 0.6, 0.7, 0.8, 0.9, 0.95]) { const a = V.profileStats(big, f); assert(a.vaVolume >= f * big.total - 1e-6, `holds ${f}`); assert(a.valRow - a.vahRow + 1 >= prev); prev = a.valRow - a.vahRow + 1; assert(a.vahRow <= a.pocRow && a.pocRow <= a.valRow); assert(a.vah > a.val); }
// minimal: taking away the area's smaller end level would drop it below the share
for (const f of [0.6, 0.7, 0.9]) { const a = V.profileStats(big, f); const end = Math.min(big.bins[a.vahRow], big.bins[a.valRow]); if (a.vahRow !== a.valRow) assert(a.vaVolume - end < f * big.total + 1e-6, `not larger than needed at ${f}`); }
// no volume, no stats
assert.strictEqual(V.profileStats(V.volumeProfile([], 0, 10, 5), 0.7), null); assert.strictEqual(V.profileStats(prof([0, 0, 0]), 0.7), null);

// ---- settings ----
assert.deepStrictEqual(V.parseVpConfig(undefined), V.DEFAULT_VP); assert.notStrictEqual(V.parseVpConfig(undefined), V.DEFAULT_VP);
for (const junk of [null, 3, 'x', [], {}]) assert.deepStrictEqual(V.parseVpConfig(junk), V.DEFAULT_VP);
assert.deepStrictEqual(V.parseVpConfig({ enabled: true, rows: 100, va: 80 }), { enabled: true, rows: 100, va: 80 });
for (const v of [9, 201, 2.5, '50', NaN]) assert.strictEqual(V.parseVpConfig({ rows: v }).rows, 48, `rows ${v}`);
for (const v of [49, 96, 70.5, '70', NaN]) assert.strictEqual(V.parseVpConfig({ va: v }).va, 70, `va ${v}`);
assert.strictEqual(V.parseVpConfig({ rows: 10 }).rows, 10); assert.strictEqual(V.parseVpConfig({ rows: 200 }).rows, 200); assert.strictEqual(V.parseVpConfig({ va: 50 }).va, 50); assert.strictEqual(V.parseVpConfig({ va: 95 }).va, 95);
assert.strictEqual(V.parseVpConfig({ enabled: 1 }).enabled, false);
const mem = {};
global.window = { localStorage: { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); } } };
assert.deepStrictEqual(V.loadVpConfig(), V.DEFAULT_VP);
V.saveVpConfig({ enabled: true, rows: 30, va: 90 }); assert.deepStrictEqual(V.loadVpConfig(), { enabled: true, rows: 30, va: 90 });
mem[Object.keys(mem)[0]] = '{bad'; assert.deepStrictEqual(V.loadVpConfig(), V.DEFAULT_VP);
global.window = { localStorage: { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); } } };
assert.deepStrictEqual(V.loadVpConfig(), V.DEFAULT_VP); V.saveVpConfig(V.DEFAULT_VP); delete global.window;

// ---- speed: the most candles at the most levels ----
const huge = Array.from({ length: 10000 }, (_, i) => { const m = 100 + Math.sin(i / 40) * 10, w = 0.5 + rnd(); return { t: i, o: m, h: m + w, l: m - w, c: m, v: 10 + rnd() }; });
const t0 = process.hrtime.bigint(); V.profileStats(V.volumeProfile(huge, 85, 115, 200), 0.7); const ms = Number(process.hrtime.bigint() - t0) / 1e6;
assert(ms < 100, `10k candles x 200 levels took ${ms.toFixed(1)}ms`);
console.log('volumeprofile: ok');
