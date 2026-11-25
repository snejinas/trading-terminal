// Bollinger Bands: against a naive reference, closed forms, bad data, settings, speed.
const assert = require('assert');
const I = require('../.test-build/indicators.js');
const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));

const naive = (v, p, m) => {
  const r = { mid: [], upper: [], lower: [] };
  v.forEach((_, i) => {
    if (i + 1 < p) { r.mid.push(null); r.upper.push(null); r.lower.push(null); return; }
    const w = v.slice(i + 1 - p, i + 1);
    const mean = w.reduce((a, b) => a + b, 0) / p;
    const sd = Math.sqrt(w.reduce((a, b) => a + (b - mean) ** 2, 0) / p);
    r.mid.push(mean); r.upper.push(mean + m * sd); r.lower.push(mean - m * sd);
  });
  return r;
};
const same = (a, b, msg) => {
  assert.strictEqual(a.length, b.length, msg);
  a.forEach((x, i) => { if (x === null || b[i] === null) assert.strictEqual(x, b[i], `${msg}@${i}`); else assert(close(x, b[i]), `${msg}@${i}: ${x} vs ${b[i]}`); });
};
let s = 99; const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
const walk = Array.from({ length: 300 }, () => 50 + (rnd() - 0.5) * 30);
for (const [p, m] of [[1, 2], [2, 2], [5, 1.5], [20, 2], [20, 0.1], [50, 3], [300, 2]]) {
  const got = I.bollinger(walk, p, m), want = naive(walk, p, m);
  for (const k of ['mid', 'upper', 'lower']) same(got[k], want[k], `${k} ${p},${m}`);
}

// constant series: zero-width bands
const flat = I.bollinger(Array(40).fill(7), 10, 2);
assert(flat.upper.slice(9).every((x) => close(x, 7)) && flat.lower.slice(9).every((x) => close(x, 7)));
// huge price, tiny variance: stays accurate (no catastrophic cancellation)
const big = I.bollinger(Array.from({ length: 30 }, (_, i) => 1e9 + (i % 2)), 10, 2);
assert(close(big.upper[29] - big.lower[29], 4 * 0.5, 1e-6), `width ${big.upper[29] - big.lower[29]}`);
// ramp 0..n-1: population sd of p consecutive integers is sqrt((p^2-1)/12); bands are symmetric about the SMA
const ramp = Array.from({ length: 60 }, (_, i) => i);
const rb = I.bollinger(ramp, 20, 2);
assert(close(rb.upper[40] - rb.mid[40], 2 * Math.sqrt((400 - 1) / 12)));
assert(close(rb.mid[40] - rb.lower[40], rb.upper[40] - rb.mid[40]));
// warm-up and short data
assert.strictEqual(rb.mid.findIndex((x) => x !== null), 19);
assert(I.bollinger([1, 2], 5, 2).upper.every((x) => x === null));
assert.deepStrictEqual(I.bollinger([], 5, 2), { mid: [], upper: [], lower: [] });
// invalid parameters
for (const [p, m] of [[0, 2], [-1, 2], [2.5, 2], [NaN, 2], [20, NaN], [20, -1], [20, Infinity]]) assert(I.bollinger(walk, p, m).mid.every((x) => x === null), `${p},${m}`);
// bad data nulls only the windows containing it
const dirty = [1, 2, 3, NaN, 5, 6, 7, 8, 9];
assert.deepStrictEqual(I.bollinger(dirty, 3, 2).mid.map((x) => x !== null), [false, false, true, false, false, false, true, true, true]);
// candles use closes; labels
const cs = [1, 2, 3, 4].map((c, t) => ({ t, o: c, h: c + 5, l: c - 5, c }));
assert(close(I.bollingerOf(cs, { period: 2, mult: 1 }).upper[1], 1.5 + 0.5));
assert.strictEqual(I.bbLabel({ period: 20, mult: 2 }), 'BB 20,2'); assert.strictEqual(I.bbLabel({ period: 10, mult: 1.5 }), 'BB 10,1.5');

// config
assert.deepStrictEqual(I.parseBbConfig(undefined), I.DEFAULT_BB);
assert.notStrictEqual(I.parseBbConfig(undefined), I.DEFAULT_BB);
for (const junk of [null, 3, 'x', [], {}]) assert.deepStrictEqual(I.parseBbConfig(junk), I.DEFAULT_BB);
assert.deepStrictEqual(I.parseBbConfig({ enabled: true, period: 30, mult: 2.5 }), { enabled: true, period: 30, mult: 2.5 });
assert.deepStrictEqual(I.parseBbConfig({ enabled: 1, period: 0, mult: 0 }), I.DEFAULT_BB);
assert.strictEqual(I.parseBbConfig({ period: 501 }).period, 20); assert.strictEqual(I.parseBbConfig({ period: 500 }).period, 500);
assert.strictEqual(I.parseBbConfig({ mult: 10.1 }).mult, 2); assert.strictEqual(I.parseBbConfig({ mult: 0.1 }).mult, 0.1); assert.strictEqual(I.parseBbConfig({ mult: 0.05 }).mult, 2);
assert.strictEqual(I.parseBbConfig({ mult: NaN }).mult, 2); assert.strictEqual(I.parseBbConfig({ mult: '3' }).mult, 2);

const mem = {};
global.window = { localStorage: { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); } } };
assert.deepStrictEqual(I.loadBbConfig(), I.DEFAULT_BB);
I.saveBbConfig({ enabled: true, period: 14, mult: 1.5 });
assert.deepStrictEqual(I.loadBbConfig(), { enabled: true, period: 14, mult: 1.5 });
mem[Object.keys(mem)[0]] = '{oops'; assert.deepStrictEqual(I.loadBbConfig(), I.DEFAULT_BB);
global.window = { localStorage: { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); } } };
assert.deepStrictEqual(I.loadBbConfig(), I.DEFAULT_BB); I.saveBbConfig(I.DEFAULT_BB);
delete global.window;

// speed at the largest history and period
const h = Array.from({ length: 10000 }, (_, i) => 100 + Math.sin(i / 40) * 9 + rnd());
for (const p of [20, 500]) {
  const t0 = process.hrtime.bigint();
  I.bollinger(h, p, 2);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert(ms < 100, `period ${p} over 10k candles took ${ms.toFixed(1)}ms`);
}
console.log('bollinger: ok');
