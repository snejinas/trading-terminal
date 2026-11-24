// Moving averages: SMA / EMA against naive references, warm-up, bad data, config parsing, speed.
const assert = require('assert');
const I = require('../.test-build/indicators.js');

const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));
const C = (c, t = 0) => ({ t, o: c, h: c, l: c, c });

// naive references
const naiveSma = (v, p) => v.map((_, i) => (i + 1 < p ? null : v.slice(i + 1 - p, i + 1).reduce((a, b) => a + b, 0) / p));
const naiveEma = (v, p) => {
  const out = v.map(() => null);
  if (v.length < p) return out;
  const k = 2 / (p + 1);
  let prev = v.slice(0, p).reduce((a, b) => a + b, 0) / p;
  out[p - 1] = prev;
  for (let i = p; i < v.length; i++) { prev = v[i] * k + prev * (1 - k); out[i] = prev; }
  return out;
};
const same = (a, b, msg) => {
  assert.strictEqual(a.length, b.length, msg + ' length');
  a.forEach((x, i) => { if (x === null || b[i] === null) assert.strictEqual(x, b[i], `${msg} @${i}`); else assert(close(x, b[i]), `${msg} @${i}: ${x} vs ${b[i]}`); });
};

// deterministic pseudo-random walk
let s = 12345; const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
const walk = Array.from({ length: 400 }, () => 100 + (rnd() - 0.5) * 20);

for (const p of [1, 2, 3, 7, 20, 50, 200, 400]) {
  same(I.sma(walk, p), naiveSma(walk, p), `sma ${p}`);
  same(I.ema(walk, p), naiveEma(walk, p), `ema ${p}`);
}

// warm-up: exactly period-1 leading nulls; period longer than the data is all null
const w = I.sma([1, 2, 3, 4, 5], 3);
assert.deepStrictEqual(w.map((x) => (x === null ? null : +x.toFixed(6))), [null, null, 2, 3, 4]);
assert.deepStrictEqual(I.sma([1, 2], 5), [null, null]);
assert.deepStrictEqual(I.ema([1, 2], 5), [null, null]);
assert.deepStrictEqual(I.sma([], 3), []);
assert.deepStrictEqual(I.ema([], 3), []);

// invalid periods produce nothing rather than throwing
for (const bad of [0, -1, 1.5, NaN, Infinity]) {
  assert(I.sma([1, 2, 3], bad).every((x) => x === null), `sma bad ${bad}`);
  assert(I.ema([1, 2, 3], bad).every((x) => x === null), `ema bad ${bad}`);
}

// constants stay constant
assert(I.sma(Array(60).fill(42), 20).slice(19).every((x) => close(x, 42)));
assert(I.ema(Array(60).fill(42), 20).slice(19).every((x) => close(x, 42)));

// ramp: SMA of 0..n-1 over p is i - (p-1)/2
const ramp = Array.from({ length: 100 }, (_, i) => i);
I.sma(ramp, 10).forEach((x, i) => { if (i >= 9) assert(close(x, i - 4.5), `ramp sma ${i}`); });
// EMA lags a rising ramp, but by less than the SMA of the same period for short periods and always trails the price
I.ema(ramp, 10).forEach((x, i) => { if (i >= 9) assert(x < i, `ema trails ${i}`); });

// period 1 is the series itself
same(I.sma(walk, 1), walk, 'sma1'); same(I.ema(walk, 1), walk, 'ema1');

// non-finite inputs: SMA nulls any window containing one and recovers; EMA holds, and cannot seed on garbage
const dirty = [1, 2, 3, NaN, 5, 6, 7, 8];
assert.deepStrictEqual(I.sma(dirty, 3).map((x) => (x === null ? null : +x.toFixed(6))), [null, null, 2, null, null, null, 6, 7]);
assert(I.ema([NaN, 2, 3, 4], 2).every((x) => x === null));
const held = I.ema([1, 2, 3, NaN, 5], 2);
assert(held.every((x, i) => (i === 0 ? x === null : Number.isFinite(x))), 'ema keeps producing numbers after a bad value');
assert(close(held[3], held[2]), 'ema holds across a bad value');

// candles: uses closes
const candles = [1, 2, 3, 4, 5].map((c, i) => C(c, i));
same(I.movingAverage(candles, { type: 'sma', period: 2 }), [null, 1.5, 2.5, 3.5, 4.5], 'candles sma');
const all = I.computeMovingAverages(candles, [
  { type: 'sma', period: 2, enabled: true },
  { type: 'ema', period: 2, enabled: false },
  { type: 'sma', period: 5, enabled: true },
]);
assert.strictEqual(all.length, 3); assert.strictEqual(all[1], null); assert.strictEqual(all[2][4], 3);

// labels
assert.strictEqual(I.maLabel({ type: 'sma', period: 20 }), 'SMA 20');
assert.strictEqual(I.maLabel({ type: 'ema', period: 200 }), 'EMA 200');

// config parsing
const dflt = I.parseMaConfig(undefined);
assert.deepStrictEqual(dflt, I.DEFAULT_MAS);
assert.notStrictEqual(dflt[0], I.DEFAULT_MAS[0], 'defaults are copied, not shared');
for (const junk of [null, 5, 'x', {}, [], [null, 3, 'a'], [[], [], []]]) assert.deepStrictEqual(I.parseMaConfig(junk), I.DEFAULT_MAS, JSON.stringify(junk));
const mixed = I.parseMaConfig([{ type: 'ema', period: 9, enabled: false }, { type: 'bogus', period: 0, enabled: 'yes' }, { type: 'sma', period: 501, enabled: true }, { period: 7 }]);
assert.deepStrictEqual(mixed, [
  { type: 'ema', period: 9, enabled: false },
  { type: 'sma', period: 50, enabled: true },
  { type: 'sma', period: 200, enabled: true },
]);
assert.strictEqual(I.parseMaConfig([{ period: 500 }])[0].period, 500);
assert.strictEqual(I.parseMaConfig([{ period: 1 }])[0].period, 1);
assert.strictEqual(I.parseMaConfig([{ period: 1.5 }])[0].period, 20);
assert.strictEqual(I.parseMaConfig([{ period: '9' }])[0].period, 20);

// storage: round-trips, survives corrupt and blocked storage
const mem = {};
global.window = { localStorage: { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); } } };
assert.deepStrictEqual(I.loadMaConfig(), I.DEFAULT_MAS);
const custom = [{ type: 'ema', period: 12, enabled: true }, { type: 'ema', period: 26, enabled: true }, { type: 'sma', period: 100, enabled: false }];
I.saveMaConfig(custom);
assert.deepStrictEqual(I.loadMaConfig(), custom);
mem[Object.keys(mem)[0]] = '{not json';
assert.deepStrictEqual(I.loadMaConfig(), I.DEFAULT_MAS);
global.window = { localStorage: { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } } };
assert.deepStrictEqual(I.loadMaConfig(), I.DEFAULT_MAS);
I.saveMaConfig(custom); // must not throw
delete global.window;

// speed: three averages over the maximum history stay far under a frame
const big = Array.from({ length: 10000 }, (_, i) => C(100 + Math.sin(i / 50) * 10 + rnd(), i));
const t0 = process.hrtime.bigint();
for (let k = 0; k < 10; k++) I.computeMovingAverages(big, [{ type: 'sma', period: 20, enabled: true }, { type: 'sma', period: 50, enabled: true }, { type: 'ema', period: 200, enabled: true }]);
const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 10;
assert(ms < 25, `three MAs over 10k candles took ${ms.toFixed(1)}ms`);

console.log('indicators: ok');
