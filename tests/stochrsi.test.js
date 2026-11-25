// Stochastic RSI: a hand-worked example, a naive reference, invariants, bad data, settings.
const assert = require('assert');
const I = require('../.test-build/indicators.js');
const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));

// ---- naive reference, written the long way (own RSI, own windows) ----
const naiveRsi = (v, p) => {
  const out = v.map(() => null);
  const g = [], l = [];
  for (let i = 1; i < v.length; i++) { g.push(Math.max(v[i] - v[i - 1], 0)); l.push(Math.max(v[i - 1] - v[i], 0)); }
  if (g.length < p) return out;
  let ag = g.slice(0, p).reduce((a, b) => a + b) / p, al = l.slice(0, p).reduce((a, b) => a + b) / p;
  const val = () => (al === 0 ? (ag === 0 ? 50 : 100) : 100 - 100 / (1 + ag / al));
  out[p] = val();
  for (let j = p; j < g.length; j++) { ag = (ag * (p - 1) + g[j]) / p; al = (al * (p - 1) + l[j]) / p; out[j + 1] = val(); }
  return out;
};
const sma = (v, p) => v.map((_, i) => (i + 1 < p || v.slice(i + 1 - p, i + 1).some((x) => x === null) ? null : v.slice(i + 1 - p, i + 1).reduce((a, b) => a + b, 0) / p));
const naive = (closes, rp, sp, ks, ds) => {
  const r = naiveRsi(closes, rp);
  const raw = r.map((x, i) => {
    if (i + 1 < sp) return null;
    const w = r.slice(i + 1 - sp, i + 1);
    if (w.some((y) => y === null)) return null;
    const hh = Math.max(...w), ll = Math.min(...w);
    return hh === ll ? 50 : (100 * (x - ll)) / (hh - ll);
  });
  const k = sma(raw, ks);
  return { k, d: sma(k, ds) };
};

// ---- a hand-worked example: RSI period 2 over these closes ----
// changes: +1 +1 -2 +3 -1 ; RSI(2): idx2 = 100, idx3: avgG=(1+0)/2... see below
const closes = [10, 11, 12, 10, 13, 12];
const r2 = I.rsi(closes, 2);
// idx2: gains (1,1), losses (0,0)  -> avgG 1, avgL 0  -> RSI 100
// idx3: change -2: avgG = (1*1+0)/2 = .5, avgL = (0*1+2)/2 = 1 -> RS .5 -> 33.333...
// idx4: change +3: avgG = (.5+3)/2 = 1.75, avgL = (1+0)/2 = .5 -> RS 3.5 -> 77.777...
// idx5: change -1: avgG = (1.75+0)/2 = .875, avgL = (.5+1)/2 = .75 -> RS 1.1667 -> 53.846...
assert.deepStrictEqual(r2.slice(0, 2), [null, null]);
assert(close(r2[2], 100) && close(r2[3], 100 - 100 / 1.5) && close(r2[4], 100 - 100 / 4.5) && close(r2[5], 100 - 100 / (1 + 0.875 / 0.75)));
// StochRSI with a 2-reading lookback and no smoothing: where the latest RSI sits between the last two
const hand = I.stochRsi(closes, 2, 2, 1, 1);
assert.deepStrictEqual(hand.k.slice(0, 3), [null, null, null]);           // needs two RSI readings (idx 2 and 3)
assert(close(hand.k[3], 0), `${hand.k[3]}`);                               // RSI fell 100 -> 33.3: at its low
assert(close(hand.k[4], 100), `${hand.k[4]}`);                             // 33.3 -> 77.8: at its high
assert(close(hand.k[5], 0), `${hand.k[5]}`);                               // 77.8 -> 53.8: at its low
// smoothing: %K over 2 = mean of consecutive raw values, %D over 2 = mean of those
const sm = I.stochRsi(closes, 2, 2, 2, 2);
assert.deepStrictEqual(sm.k.slice(0, 4), [null, null, null, null]); assert(close(sm.k[4], 50) && close(sm.k[5], 50));
assert.deepStrictEqual(sm.d.slice(0, 5), [null, null, null, null, null]); assert(close(sm.d[5], 50));

// ---- against the naive reference on random walks ----
let s = 11; const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
let px = 100; const walk = Array.from({ length: 400 }, () => (px *= 1 + (rnd() - 0.5) * 0.02));
for (const [a, b, c, d] of [[2, 2, 1, 1], [14, 14, 3, 3], [14, 14, 1, 1], [5, 9, 2, 4], [14, 3, 3, 3], [30, 50, 5, 5], [100, 100, 3, 3]]) {
  const x = I.stochRsi(walk, a, b, c, d), y = naive(walk, a, b, c, d);
  for (const key of ['k', 'd']) x[key].forEach((v, i) => { if (v === null || y[key][i] === null) assert.strictEqual(v, y[key][i], `${key} ${a},${b},${c},${d}@${i}`); else assert(close(v, y[key][i], 1e-7), `${key}@${i}: ${v} vs ${y[key][i]}`); });
}
// warm-up: RSI needs `rsi` changes, then the lookback, then the smoothings
const w = I.stochRsi(walk, 14, 14, 3, 3);
assert.strictEqual(w.k.findIndex((x) => x !== null), 14 + 14 - 1 + 3 - 1);
assert.strictEqual(w.d.findIndex((x) => x !== null), 14 + 14 - 1 + 3 - 1 + 3 - 1);

// ---- bounds and extremes ----
assert([...w.k, ...w.d].every((x) => x === null || (x >= 0 && x <= 100)));
const up = Array.from({ length: 80 }, (_, i) => 10 + i);
assert(I.stochRsi(up, 14, 14, 3, 3).k.slice(40).every((x) => x === 50), 'a constant RSI (all gains) has no range: 50');
assert(I.stochRsi(Array(80).fill(5), 14, 14, 3, 3).k.slice(40).every((x) => x === 50));
// after a long rise then a drop the RSI is at the bottom of its recent range
const dropped = [...Array.from({ length: 40 }, (_, i) => 100 + i), ...Array.from({ length: 6 }, (_, i) => 139 - 3 * (i + 1))];
assert(I.stochRsi(dropped, 14, 14, 1, 1).k.at(-1) < 5);
// scale and shift invariance
const base = I.stochRsi(walk, 14, 14, 3, 3), moved = I.stochRsi(walk.map((x) => x * 1000 + 5e6), 14, 14, 3, 3);
base.k.forEach((x, i) => { if (x !== null) assert(close(x, moved.k[i], 1e-6), `invariant @${i}`); });
// more sensitive than the RSI: it reaches both extremes far more often
const rr = I.rsi(walk, 14), sr = I.stochRsi(walk, 14, 14, 1, 1).k;
const touches = (arr, lo, hi) => arr.filter((x) => x !== null && (x <= lo || x >= hi)).length;
assert(touches(sr, 5, 95) > touches(rr, 5, 95) * 3, 'StochRSI visits the extremes much more often than RSI');

// ---- short / empty / invalid input ----
assert(I.stochRsi(walk.slice(0, 20), 14, 14, 3, 3).k.every((x) => x === null));
assert.deepStrictEqual(I.stochRsi([], 14, 14, 3, 3), { k: [], d: [] });
for (const bad of [[1, 14, 3, 3], [14, 1, 3, 3], [14, 14, 0, 3], [14, 14, 3, 0], [2.5, 14, 3, 3], [14, NaN, 3, 3], [14, 14, -1, 3]]) { const r = I.stochRsi(walk, ...bad); assert(r.k.every((x) => x === null) && r.d.every((x) => x === null), String(bad)); }
// bad data: nulls the RSI readings it touches, recovers afterwards
const dirty = walk.slice(0, 120); dirty[60] = NaN;
const dd = I.stochRsi(dirty, 5, 5, 1, 1).k;
assert.strictEqual(dd[60], null); assert(dd[59] !== null && Number.isFinite(dd[59])); assert(dd[61] === null || Number.isFinite(dd[61])); assert(dd.slice(75).every((x) => x !== null), 'recovers once a full window is clean');
// candles + label
const cs = walk.map((c, t) => ({ t, o: c, h: c, l: c, c }));
const viaCandles = I.stochRsiOf(cs, { rsi: 14, stoch: 14, k: 3, d: 3 }); assert.deepStrictEqual(viaCandles.k, base.k);
assert.strictEqual(I.stochRsiLabel({ rsi: 14, stoch: 14, k: 3, d: 3 }), 'StochRSI 14,14,3,3');

// ---- settings ----
assert.deepStrictEqual(I.parseStochRsiConfig(undefined), I.DEFAULT_STOCHRSI);
assert.notStrictEqual(I.parseStochRsiConfig(undefined), I.DEFAULT_STOCHRSI);
for (const junk of [null, 3, 'x', [], {}]) assert.deepStrictEqual(I.parseStochRsiConfig(junk), I.DEFAULT_STOCHRSI);
assert.deepStrictEqual(I.parseStochRsiConfig({ enabled: true, rsi: 9, stoch: 21, k: 1, d: 5 }), { enabled: true, rsi: 9, stoch: 21, k: 1, d: 5 });
for (const key of ['rsi', 'stoch']) { for (const v of [1, 201, 2.5, '9', NaN]) assert.strictEqual(I.parseStochRsiConfig({ [key]: v })[key], 14, `${key}=${v}`); assert.strictEqual(I.parseStochRsiConfig({ [key]: 2 })[key], 2); assert.strictEqual(I.parseStochRsiConfig({ [key]: 200 })[key], 200); }
for (const key of ['k', 'd']) { for (const v of [0, 51, 1.5, '3', NaN]) assert.strictEqual(I.parseStochRsiConfig({ [key]: v })[key], 3, `${key}=${v}`); assert.strictEqual(I.parseStochRsiConfig({ [key]: 1 })[key], 1); assert.strictEqual(I.parseStochRsiConfig({ [key]: 50 })[key], 50); }
assert.strictEqual(I.parseStochRsiConfig({ enabled: 'yes' }).enabled, false);
const mem = {};
global.window = { localStorage: { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); } } };
assert.deepStrictEqual(I.loadStochRsiConfig(), I.DEFAULT_STOCHRSI);
I.saveStochRsiConfig({ enabled: true, rsi: 21, stoch: 9, k: 5, d: 4 }); assert.deepStrictEqual(I.loadStochRsiConfig(), { enabled: true, rsi: 21, stoch: 9, k: 5, d: 4 });
mem[Object.keys(mem)[0]] = '{bad'; assert.deepStrictEqual(I.loadStochRsiConfig(), I.DEFAULT_STOCHRSI);
global.window = { localStorage: { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); } } };
assert.deepStrictEqual(I.loadStochRsiConfig(), I.DEFAULT_STOCHRSI); I.saveStochRsiConfig(I.DEFAULT_STOCHRSI);
delete global.window;
// the removed settings are really gone
for (const gone of ['loadRsiConfig', 'saveRsiConfig', 'parseRsiConfig', 'stochastic', 'loadStochConfig', 'saveStochConfig', 'parseStochConfig', 'rsiOf']) assert.strictEqual(I[gone], undefined, gone);

const big = Array.from({ length: 10000 }, (_, i) => 100 + Math.sin(i / 30) * 9 + rnd());
for (const sp of [14, 200]) { const t0 = process.hrtime.bigint(); I.stochRsi(big, 14, sp, 3, 3); const ms = Number(process.hrtime.bigint() - t0) / 1e6; assert(ms < 100, `lookback ${sp} took ${ms.toFixed(1)}ms`); }
console.log('stochrsi: ok');
