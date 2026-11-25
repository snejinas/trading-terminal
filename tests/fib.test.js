// Fibonacci retracement: level maths, time<->index mapping, hit-testing, parsing and storage.
const assert = require('assert');
const F = require('../.test-build/fib.js');
const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));

// levels: 0 at the end of the move (b), 1 at its start (a); extensions run past a
const up = { a: { t: 0, p: 100 }, b: { t: 1, p: 200 } };      // a rally from 100 to 200
assert.strictEqual(F.levelPrice(up, 0), 200); assert.strictEqual(F.levelPrice(up, 1), 100);
assert(close(F.levelPrice(up, 0.5), 150)); assert(close(F.levelPrice(up, 0.618), 200 - 61.8)); assert(close(F.levelPrice(up, 0.236), 176.4));
assert(close(F.levelPrice(up, 1.618), 200 - 161.8), 'extension runs below the start of a rally');
const down = { a: { t: 0, p: 200 }, b: { t: 1, p: 100 } };    // a drop from 200 to 100: retracement levels are above b
assert(close(F.levelPrice(down, 0.618), 100 + 61.8)); assert(close(F.levelPrice(down, 1.272), 100 + 127.2));
assert.deepStrictEqual(F.fibLevels(false), [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]);
assert.deepStrictEqual(F.fibLevels(true), [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.272, 1.618, 2.618]);
// levels are monotonic in the ratio, whichever way the move went
for (const f of [up, down]) { const ps = F.fibLevels(true).map((r) => F.levelPrice(f, r)); const dir = Math.sign(ps[1] - ps[0]); ps.slice(1).forEach((p, i) => assert(Math.sign(p - ps[i]) === dir)); }
assert.strictEqual(F.fibColor(0.618), '#22d3ee'); assert.strictEqual(F.fibColor(1.618), F.FIB_EXT_COLOR);

// time <-> index
const M = 60000;
const flat = Array.from({ length: 10 }, (_, i) => ({ t: 1000000 + i * M }));
assert.strictEqual(F.timeToIndex(flat, flat[3].t, M), 3);
assert(close(F.timeToIndex(flat, flat[3].t + M / 2, M), 3.5));
assert(close(F.timeToIndex(flat, flat[9].t + 5 * M, M), 14), 'extrapolates past the newest candle');
assert(close(F.timeToIndex(flat, flat[0].t - 3 * M, M), -3), 'extrapolates before the oldest candle');
assert.strictEqual(F.indexToTime(flat, 3, M), flat[3].t); assert.strictEqual(F.indexToTime(flat, 14, M), flat[9].t + 5 * M); assert.strictEqual(F.indexToTime(flat, -3, M), flat[0].t - 3 * M);
for (const idx of [-7.25, -1, 0, 0.5, 2.75, 8.999, 9, 9.5, 20.125]) assert(close(F.timeToIndex(flat, F.indexToTime(flat, idx, M), M), idx, 1e-9), `roundtrip ${idx}`);
// gaps in the data: a missing candle still maps linearly between its neighbours
const gappy = [{ t: 0 }, { t: M }, { t: 5 * M }, { t: 6 * M }];
assert(close(F.timeToIndex(gappy, 3 * M, M), 1.5)); assert(close(F.indexToTime(gappy, 1.5, M), 3 * M));
for (const idx of [0.2, 1.5, 1.99, 2.5]) assert(close(F.timeToIndex(gappy, F.indexToTime(gappy, idx, M), M), idx, 1e-9));
// snapping
assert.strictEqual(F.snapTime(flat, 3.4, M), flat[3].t); assert.strictEqual(F.snapTime(flat, 3.6, M), flat[4].t);
assert.strictEqual(F.snapTime(flat, 11.2, M), flat[9].t + 2 * M); assert.strictEqual(F.snapTime(flat, -0.7, M), flat[0].t - M);
// empty data and a bad timeframe do not blow up
assert.strictEqual(F.timeToIndex([], 5, M), 0); assert.strictEqual(F.indexToTime([], 5, M), 0);
assert(Number.isFinite(F.timeToIndex(flat, flat[9].t + M, 0))); assert(Number.isFinite(F.indexToTime(flat, 12, NaN)) || Number.isNaN(F.indexToTime(flat, 12, NaN)));
// a retracement drawn on 1m candles is still placed correctly on 5m candles
const five = Array.from({ length: 4 }, (_, i) => ({ t: i * 5 * M }));
assert(close(F.timeToIndex(five, 7.5 * M, 5 * M), 1.5));

// hit-testing
const pts = [{ id: 'a', x: 10, y: 10 }, { id: 'b', x: 14, y: 10 }, { id: 'c', x: 100, y: 100 }];
assert.strictEqual(F.nearestHandle(pts, 13, 10, 9).id, 'b', 'nearest wins');
assert.strictEqual(F.nearestHandle(pts, 11, 10, 9).id, 'a');
assert.strictEqual(F.nearestHandle(pts, 50, 50, 9), null); assert.strictEqual(F.nearestHandle([], 1, 1, 9), null);
assert.strictEqual(F.nearestHandle(pts, 109, 100, 9).id, 'c', 'radius is inclusive'); assert.strictEqual(F.nearestHandle(pts, 109.1, 100, 9), null);
assert.strictEqual(F.nearestHandle([{ id: 'x', x: 5, y: 5 }, { id: 'y', x: 5, y: 5 }], 5, 5, 9).id, 'y', 'ties go to the one drawn last');

// parsing
const good = { id: 'one', a: { t: 1000, p: 5 }, b: { t: 2000, p: 9 } };
assert.deepStrictEqual(F.parseFibs([good]), [good]);
for (const junk of [null, undefined, 3, 'x', {}, [null, 3, 'x', [], {}]]) assert.deepStrictEqual(F.parseFibs(junk), [], String(junk));
assert.strictEqual(F.parseFibs([{ ...good, a: { t: NaN, p: 1 } }]).length, 0); assert.strictEqual(F.parseFibs([{ ...good, b: { t: 1, p: Infinity } }]).length, 0);
assert.strictEqual(F.parseFibs([{ ...good, a: { t: -5, p: 1 } }]).length, 0); assert.strictEqual(F.parseFibs([{ ...good, a: { t: 5e12, p: 1 } }]).length, 0);
assert.strictEqual(F.parseFibs([{ ...good, a: { t: '1', p: 1 } }]).length, 0);
assert.strictEqual(F.parseFibs([{ id: 'z', a: { t: 5, p: 5 }, b: { t: 5, p: 5 } }]).length, 0, 'zero-extent dropped');
assert.strictEqual(F.parseFibs([{ id: 'z', a: { t: 5, p: 5 }, b: { t: 5, p: 6 } }]).length, 1, 'vertical is fine');
const noId = F.parseFibs([{ a: good.a, b: good.b }, { id: 5, a: good.a, b: good.b }, { id: '', a: good.a, b: good.b }]);
assert.strictEqual(noId.length, 3); assert.strictEqual(new Set(noId.map((f) => f.id)).size, 3, 'ids are made unique');
const dup = F.parseFibs([good, good, good]); assert.strictEqual(new Set(dup.map((f) => f.id)).size, 3);
assert.strictEqual(F.parseFibs([{ ...good, id: 'x'.repeat(41) }])[0].id, 'f0');
assert.strictEqual(F.parseFibs(Array.from({ length: 30 }, (_, i) => ({ ...good, id: 'i' + i }))).length, F.FIB_MAX_PER_SYMBOL);
const extra = F.parseFibs([{ ...good, evil: 1, a: { t: 1, p: 2, z: 3 } }]); assert.deepStrictEqual(Object.keys(extra[0]).sort(), ['a', 'b', 'id']); assert.deepStrictEqual(Object.keys(extra[0].a).sort(), ['p', 't']);

// storage: per symbol, survives corrupt and blocked storage
const mem = {};
global.window = { localStorage: { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } } };
assert.deepStrictEqual(F.loadFibs('BTCUSDT'), []);
F.saveFibs('BTCUSDT', [good]); F.saveFibs('ETHUSDT', [{ ...good, id: 'eth' }]);
assert.deepStrictEqual(F.loadFibs('BTCUSDT'), [good]); assert.strictEqual(F.loadFibs('ETHUSDT')[0].id, 'eth'); assert.deepStrictEqual(F.loadFibs('SOLUSDT'), []);
F.saveFibs('BTCUSDT', []); assert.deepStrictEqual(F.loadFibs('BTCUSDT'), []); assert.strictEqual(Object.keys(mem).length, 1, 'empty list removes the key');
mem[Object.keys(mem)[0]] = '{nope'; assert.deepStrictEqual(F.loadFibs('ETHUSDT'), []);
assert.strictEqual(F.loadFibExtensions(), false); F.saveFibExtensions(true); assert.strictEqual(F.loadFibExtensions(), true); F.saveFibExtensions(false); assert.strictEqual(F.loadFibExtensions(), false);
global.window = { localStorage: { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); }, removeItem() { throw new Error('x'); } } };
assert.deepStrictEqual(F.loadFibs('BTCUSDT'), []); F.saveFibs('BTCUSDT', [good]); F.saveFibs('BTCUSDT', []); assert.strictEqual(F.loadFibExtensions(), false); F.saveFibExtensions(true);
delete global.window;
// ids
const ids = new Set(Array.from({ length: 500 }, () => F.newFibId())); assert.strictEqual(ids.size, 500);
console.log('fib: ok');
