// Stochastic oscillator: a hand-worked example, a naive reference, invariants, bad data, settings.
const assert = require('assert');
const I = require('../.test-build/indicators.js');
const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));
const K = (h, l, c, t = 0) => ({ t, o: c, h, l, c });

// hand-worked: (high, low, close) rows, lookback 3
const rows = [[10, 5, 8], [12, 6, 11], [11, 4, 5], [9, 3, 4], [13, 7, 12]].map(([h, l, c], t) => K(h, l, c, t));
const fast = I.stochastic(rows, 3, 1, 2);
assert.deepStrictEqual(fast.k.slice(0, 2), [null, null]);
assert(close(fast.k[2], 12.5), `${fast.k[2]}`);         // HH 12, LL 4: (5-4)/8
assert(close(fast.k[3], 100 / 9), `${fast.k[3]}`);       // HH 12, LL 3: (4-3)/9
assert(close(fast.k[4], 90), `${fast.k[4]}`);            // HH 13, LL 3: (12-3)/10
assert.strictEqual(fast.d[2], null);
assert(close(fast.d[3], (12.5 + 100 / 9) / 2)); assert(close(fast.d[4], (100 / 9 + 90) / 2));
// slow: %K is the 2-period SMA of those
const slow = I.stochastic(rows, 3, 2, 2);
assert.strictEqual(slow.k[2], null); assert(close(slow.k[3], (12.5 + 100 / 9) / 2)); assert(close(slow.k[4], (100 / 9 + 90) / 2));
assert.strictEqual(slow.d[3], null); assert(close(slow.d[4], (slow.k[3] + slow.k[4]) / 2));

// naive reference on a random walk with real ranges
let s = 5; const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
let px = 100;
const walk = Array.from({ length: 250 }, (_, t) => { px += (rnd() - 0.5) * 4; const c = px, h = c + rnd() * 2, l = c - rnd() * 2; return K(h, l, c, t); });
const sma = (v, p) => v.map((_, i) => (i + 1 < p || v.slice(i + 1 - p, i + 1).some((x) => x === null) ? null : v.slice(i + 1 - p, i + 1).reduce((a, b) => a + b, 0) / p));
const naive = (cs, k, sm, d) => {
  const raw = cs.map((_, i) => {
    if (i + 1 < k) return null;
    const w = cs.slice(i + 1 - k, i + 1), hh = Math.max(...w.map((x) => x.h)), ll = Math.min(...w.map((x) => x.l));
    return hh === ll ? 50 : (100 * (cs[i].c - ll)) / (hh - ll);
  });
  const kk = sma(raw, sm);
  return { k: kk, d: sma(kk, d) };
};
for (const [k, sm, d] of [[2, 1, 1], [5, 3, 3], [14, 3, 3], [14, 1, 3], [30, 5, 7], [200, 3, 3]]) {
  const a = I.stochastic(walk, k, sm, d), b = naive(walk, k, sm, d);
  for (const key of ['k', 'd']) a[key].forEach((x, i) => { if (x === null || b[key][i] === null) assert.strictEqual(x, b[key][i], `${key} ${k},${sm},${d}@${i}`); else assert(close(x, b[key][i]), `${key}@${i}`); });
}
// warm-up lengths
const w = I.stochastic(walk, 14, 3, 3);
assert.strictEqual(w.k.findIndex((x) => x !== null), 14 - 1 + 3 - 1);
assert.strictEqual(w.d.findIndex((x) => x !== null), 14 - 1 + 3 - 1 + 3 - 1);

// extremes and bounds
const climbing = Array.from({ length: 30 }, (_, t) => K(t + 1, t - 1, t + 1, t)); // closes at the high
assert(I.stochastic(climbing, 5, 1, 1).k.slice(4).every((x) => x > 80), 'closing near highs reads high');
assert(I.stochastic(Array.from({ length: 30 }, (_, t) => K(100 - t + 0.0, 100 - t - 1, 100 - t - 1, t)), 5, 1, 1).k.slice(4).every((x) => x === 0), 'closing at the low reads 0');
assert(I.stochastic(Array.from({ length: 30 }, (_, t) => K(t + 1, t - 1, t + 1, t)).map((c) => ({ ...c, c: c.h })), 5, 1, 1).k.slice(4).every((x) => x === 100));
assert(I.stochastic(Array.from({ length: 20 }, (_, t) => K(5, 5, 5, t)), 5, 3, 3).k.slice(6).every((x) => x === 50), 'no range reads 50');
assert([...w.k, ...w.d].every((x) => x === null || (x >= 0 && x <= 100)));
// price shift / scale invariance
const moved = walk.map((c) => K(c.h * 7 + 1000, c.l * 7 + 1000, c.c * 7 + 1000, c.t));
const wm = I.stochastic(moved, 14, 3, 3); w.k.forEach((x, i) => { if (x !== null) assert(close(x, wm.k[i], 1e-8), `invariant @${i}`); });

// short / empty / invalid
assert(I.stochastic(walk.slice(0, 10), 14, 3, 3).k.every((x) => x === null));
assert.deepStrictEqual(I.stochastic([], 14, 3, 3), { k: [], d: [] });
for (const bad of [[0, 3, 3], [14, 0, 3], [14, 3, 0], [2.5, 3, 3], [14, NaN, 3], [14, 3, -1]]) { const r = I.stochastic(walk, ...bad); assert(r.k.every((x) => x === null) && r.d.every((x) => x === null), String(bad)); }
// bad data nulls only windows touching it
const dirty = walk.slice(0, 60).map((c) => ({ ...c })); dirty[30].c = NaN;
const dd = I.stochastic(dirty, 5, 1, 1).k;
assert(dd.slice(30, 35).every((x) => x === null) && dd[35] !== null && dd[29] !== null);
const dirty2 = walk.slice(0, 40).map((c) => ({ ...c })); dirty2[20].h = Infinity;
assert(I.stochastic(dirty2, 3, 1, 1).k[20] === null);
assert.strictEqual(I.stochLabel({ k: 14, smooth: 3, d: 3 }), 'Stoch 14,3,3');

// config
assert.deepStrictEqual(I.parseStochConfig(undefined), I.DEFAULT_STOCH);
for (const junk of [null, 3, 'x', [], {}]) assert.deepStrictEqual(I.parseStochConfig(junk), I.DEFAULT_STOCH);
assert.deepStrictEqual(I.parseStochConfig({ enabled: true, k: 9, smooth: 1, d: 5 }), { enabled: true, k: 9, smooth: 1, d: 5 });
assert.strictEqual(I.parseStochConfig({ k: 1 }).k, 14); assert.strictEqual(I.parseStochConfig({ k: 2 }).k, 2); assert.strictEqual(I.parseStochConfig({ k: 201 }).k, 14);
assert.strictEqual(I.parseStochConfig({ smooth: 0 }).smooth, 3); assert.strictEqual(I.parseStochConfig({ smooth: 51 }).smooth, 3); assert.strictEqual(I.parseStochConfig({ smooth: 50 }).smooth, 50);
assert.strictEqual(I.parseStochConfig({ d: 0 }).d, 3); assert.strictEqual(I.parseStochConfig({ d: 2.5 }).d, 3); assert.strictEqual(I.parseStochConfig({ d: '4' }).d, 3);
const mem = {};
global.window = { localStorage: { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); } } };
assert.deepStrictEqual(I.loadStochConfig(), I.DEFAULT_STOCH);
I.saveStochConfig({ enabled: true, k: 21, smooth: 5, d: 4 }); assert.deepStrictEqual(I.loadStochConfig(), { enabled: true, k: 21, smooth: 5, d: 4 });
mem[Object.keys(mem)[0]] = '{x'; assert.deepStrictEqual(I.loadStochConfig(), I.DEFAULT_STOCH);
global.window = { localStorage: { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); } } };
assert.deepStrictEqual(I.loadStochConfig(), I.DEFAULT_STOCH); I.saveStochConfig(I.DEFAULT_STOCH);
delete global.window;

const big = Array.from({ length: 10000 }, (_, t) => { const c = 100 + Math.sin(t / 30) * 9 + rnd(); return K(c + 1, c - 1, c, t); });
for (const k of [14, 200]) { const t0 = process.hrtime.bigint(); I.stochastic(big, k, 3, 3); const ms = Number(process.hrtime.bigint() - t0) / 1e6; assert(ms < 100, `k=${k} took ${ms.toFixed(1)}ms`); }
console.log('stochastic: ok');
