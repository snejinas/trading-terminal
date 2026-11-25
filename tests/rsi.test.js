// RSI (Wilder): textbook values, a naive reference, invariants, bad data, settings.
const assert = require('assert');
const I = require('../.test-build/indicators.js');
const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));

// naive reference: arrays of gains/losses, Wilder recursion written the long way
const naive = (v, p) => {
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
let s = 7; const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
const walk = Array.from({ length: 300 }, () => 100 + (rnd() - 0.5) * 8);
for (const p of [2, 3, 5, 14, 30, 100, 200]) {
  const a = I.rsi(walk, p), b = naive(walk, p);
  a.forEach((x, i) => { if (x === null || b[i] === null) assert.strictEqual(x, b[i], `p${p}@${i}`); else assert(close(x, b[i]), `p${p}@${i} ${x} vs ${b[i]}`); });
}

// the classic worked example (Wilder / StockCharts, 14 periods). Published tables show 70.53, 66.32, 66.55
// because they round the running averages; these are the exact values, checked by hand:
// 14 changes: gains 3.34, losses 1.40 -> RS = 3.34/1.40 -> 70.464; then 66.250 and 66.481
const closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 45.64, 46.21];
const r = I.rsi(closes, 14);
assert(r.slice(0, 14).every((x) => x === null), 'first value is at index period');
assert(Math.abs(r[14] - 70.464) < 0.001, `first RSI ${r[14]}`);
assert(Math.abs(r[15] - 66.250) < 0.001, `second RSI ${r[15]}`);
assert(Math.abs(r[16] - 66.481) < 0.001, `third RSI ${r[16]}`);

// extremes and invariants
const up = Array.from({ length: 40 }, (_, i) => 10 + i), down = up.slice().reverse();
assert(I.rsi(up, 14).slice(14).every((x) => x === 100), 'only gains -> 100');
assert(I.rsi(down, 14).slice(14).every((x) => x === 0), 'only losses -> 0');
assert(I.rsi(Array(40).fill(5), 14).slice(14).every((x) => x === 50), 'no movement -> 50');
assert(I.rsi(walk, 14).every((x) => x === null || (x >= 0 && x <= 100)), 'bounded');
const alt = Array.from({ length: 200 }, (_, i) => 100 + (i % 2));
assert(Math.abs(I.rsi(alt, 14)[199] - 50) < 3, 'alternating +1/-1 stays near 50');
const base = I.rsi(walk, 14), scaled = I.rsi(walk.map((x) => x * 1000 + 5e6), 14);
base.forEach((x, i) => { if (x !== null) assert(close(x, scaled[i], 1e-6), `scale/shift invariant @${i}`); });
// a falling price after a rally lowers RSI, a rising one raises it
const rally = [...Array.from({ length: 30 }, (_, i) => 100 + i), 120, 118, 116];
assert(I.rsi(rally, 14).at(-1) < I.rsi(rally, 14).at(-4));

// short input, bad periods
assert.deepStrictEqual(I.rsi([1, 2, 3], 14), [null, null, null]);
assert.deepStrictEqual(I.rsi([], 14), []);
assert.strictEqual(I.rsi([1, 2, 3, 4], 3)[3] !== null, true);
for (const bad of [0, 1, -3, 2.5, NaN, Infinity]) assert(I.rsi(walk, bad).every((x) => x === null), `period ${bad}`);

// bad data: null at the bad index, no crash, numbers again afterwards
const dirty = walk.slice(0, 60); dirty[30] = NaN;
const d = I.rsi(dirty, 14);
assert.strictEqual(d[30], null); assert(d[31] !== null && Number.isFinite(d[31])); assert(d.slice(14, 30).every((x) => x !== null));
// a bad value inside the seed window delays the first value by one
const early = I.rsi([1, 2, NaN, 4, 3, 5, 4, 6], 3);
assert.strictEqual(early.findIndex((x) => x !== null), 4); // would be 3 without the NaN
// candles
assert(close(I.rsiOf(walk.map((c, t) => ({ t, o: c, h: c, l: c, c })), 14)[100], base[100]));

// config
assert.deepStrictEqual(I.parseRsiConfig(undefined), I.DEFAULT_RSI);
for (const junk of [null, 4, 'x', [], {}]) assert.deepStrictEqual(I.parseRsiConfig(junk), I.DEFAULT_RSI);
assert.deepStrictEqual(I.parseRsiConfig({ enabled: true, period: 9 }), { enabled: true, period: 9 });
for (const p of [1, 201, 3.5, '9', NaN]) assert.strictEqual(I.parseRsiConfig({ period: p }).period, 14, String(p));
assert.strictEqual(I.parseRsiConfig({ period: 2 }).period, 2); assert.strictEqual(I.parseRsiConfig({ period: 200 }).period, 200);
assert.strictEqual(I.parseRsiConfig({ enabled: 'yes' }).enabled, false);
const mem = {};
global.window = { localStorage: { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); } } };
assert.deepStrictEqual(I.loadRsiConfig(), I.DEFAULT_RSI);
I.saveRsiConfig({ enabled: true, period: 21 }); assert.deepStrictEqual(I.loadRsiConfig(), { enabled: true, period: 21 });
mem[Object.keys(mem)[0]] = '{bad'; assert.deepStrictEqual(I.loadRsiConfig(), I.DEFAULT_RSI);
global.window = { localStorage: { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); } } };
assert.deepStrictEqual(I.loadRsiConfig(), I.DEFAULT_RSI); I.saveRsiConfig(I.DEFAULT_RSI);
delete global.window;

const big = Array.from({ length: 10000 }, (_, i) => 100 + Math.sin(i / 30) * 8 + rnd());
const t0 = process.hrtime.bigint(); I.rsi(big, 14); const ms = Number(process.hrtime.bigint() - t0) / 1e6;
assert(ms < 25, `10k candles took ${ms.toFixed(1)}ms`);
console.log('rsi: ok');
