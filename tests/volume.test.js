// Candle volume: label formatting, aggregation/folding for higher timeframes, the Binance feed's
// per-update volume deltas, and the simulated feed's volumes.
const assert = require('assert');
const V = require('../.test-build/chartview.js');
const T = require('../.test-build/timeframes.js');
const E = require('../.test-build/engine.js');
const C = (t, o = 1, h = 2, l = 0.5, c = 1.5, v) => (v === undefined ? { t, o, h, l, c } : { t, o, h, l, c, v });

(async () => {
  // ───────── formatVolume ─────────
  const f = V.formatVolume;
  for (const bad of [0, -3, NaN, Infinity, -Infinity, undefined, null]) assert.strictEqual(f(bad), '0', String(bad));
  assert.strictEqual(f(0.0004), '<0.001', 'tiny non-zero volume must not read as 0.000');
  assert.strictEqual(f(0.045), '0.045'); assert.strictEqual(f(0.5), '0.500');
  assert.strictEqual(f(3.214), '3.21'); assert.strictEqual(f(87.4), '87.40'); assert.strictEqual(f(100), '100'); assert.strictEqual(f(742.6), '743');
  assert.strictEqual(f(1000), '1.0K'); assert.strictEqual(f(12345), '12.3K'); assert.strictEqual(f(999_000), '999.0K');
  assert.strictEqual(f(1e6), '1.00M'); assert.strictEqual(f(4_560_000), '4.56M'); assert.strictEqual(f(2.5e9), '2.50B'); assert.strictEqual(f(7.3e12), '7300.00B');
  // rounding must never print "1000.0K" / "1000.00M" / "1000": it rolls into the next unit
  assert.strictEqual(f(999.7), '1.0K'); assert.strictEqual(f(999_960), '1.00M'); assert.strictEqual(f(999_996_000), '1.00B');
  for (const x of [0.0011, 0.9996, 99.996, 999.96, 999_949, 999_950, 999_949_999, 999_950_000]) assert(!/^1000(\.0+)?[KMB]?$/.test(f(x)), `${x} -> ${f(x)}`);

  // ───────── aggregateByTime sums volume ─────────
  const base = [C(0, 10, 12, 9, 11, 5), C(1000, 11, 15, 10, 14, 7), C(2000, 14, 14, 8, 9, 1), C(3000, 9, 20, 9, 19, 4), C(4000, 19, 19, 5, 6, 2)];
  assert.deepStrictEqual(T.aggregateByTime(base, 3000), [{ t: 0, o: 10, h: 15, l: 8, c: 9, v: 13 }, { t: 3000, o: 9, h: 20, l: 5, c: 6, v: 6 }]);
  const total = x => x.reduce((s, c) => s + c.v, 0);
  assert.strictEqual(total(T.aggregateByTime(base, 3000)), total(base), 'aggregation conserves volume');
  assert.strictEqual(total(T.aggregateByTime(base, 2000)), total(base)); assert.strictEqual(total(T.aggregateByTime(base, 99999)), total(base));
  assert.deepStrictEqual(T.aggregateByTime([C(0), C(1000)], 3000), [C(0, 1, 2, 0.5, 1.5)], 'no volume in -> no volume property out');
  assert.deepStrictEqual(T.aggregateByTime([C(0, 1, 2, 1, 1, 4), C(1000)], 3000)[0].v, 4, 'mixed: missing counts as nothing');

  // ───────── foldCandle volume (dv = volume since the previous update of that minute) ─────────
  const H = 3600e3, hr = Date.UTC(2026, 0, 1, 10);
  let l = [C(hr - H, 1, 1, 1, 1, 50), C(hr, 1, 1, 1, 1, 100)];
  T.foldCandle(l, H, C(hr + 60e3, 1, 1, 1, 1, 9), undefined, 2); assert.strictEqual(l[1].v, 102, 'same bucket: adds dv');
  T.foldCandle(l, H, C(hr + 60e3, 1, 1, 1, 1, 9), undefined, 0); assert.strictEqual(l[1].v, 102, 'dv 0 adds nothing');
  T.foldCandle(l, H, C(hr + 60e3, 1, 1, 1, 1, 9), undefined, -5); assert.strictEqual(l[1].v, 102, 'negative dv is clamped, volume never goes down');
  T.foldCandle(l, H, C(hr + H, 1, 1, 1, 1, 7), undefined, 7); assert.strictEqual(l.length, 3); assert.strictEqual(l[2].v, 7, 'new bucket starts at its own dv, not the old total');
  assert.strictEqual(l[1].v, 102, 'previous candle untouched');
  l = [C(hr, 1, 1, 1, 1)]; T.foldCandle(l, H, C(hr, 1, 1, 1, 1), undefined, 0); assert.ok(!('v' in l[0]), 'candles without volume stay without it when nothing is added');
  l = [C(hr, 1, 1, 1, 1)]; T.foldCandle(l, H, C(hr, 1, 1, 1, 1, 4), undefined, 4); assert.strictEqual(l[0].v, 4);
  l = []; T.foldCandle(l, H, C(hr, 1, 1, 1, 1, 3), undefined, 3); assert.strictEqual(l[0].v, 3, 'new candle from an empty list');

  // ───────── BinanceMarket against a fake exchange whose volumes are internally consistent ─────────
  const MIN = 60e3, FAKE_NOW = Date.UTC(2026, 0, 1, 10, 59, 30), curMin = Math.floor(FAKE_NOW / MIN) * MIN; // 10:59:30 -> in-progress minute 10:59
  const PARTIAL = 3; // volume of the in-progress minute as of the REST snapshot
  const volMin = t => 1 + (Math.round(t / MIN) % 7); // volume of a COMPLETE minute
  const volOf = (bucket, ms) => { let s = 0; for (let t = bucket; t < bucket + ms && t <= curMin; t += MIN) s += t === curMin ? PARTIAL : volMin(t); return s; };
  const msOf = id => ({ '1m': 60e3, '5m': 300e3, '15m': 900e3, '1h': 3600e3, '4h': 14400e3, '1d': 86400e3 })[id];
  const bases = { BTCUSDT: 68000, ETHUSDT: 2500, SOLUSDT: 160, BNBUSDT: 590, XRPUSDT: 0.52, DOGEUSDT: 0.15 };
  let omitVolume = false;
  globalThis.fetch = async url => {
    const u = new URL(url);
    if (u.pathname.endsWith('/ticker/24hr')) return { ok: true, json: async () => Object.entries(bases).map(([symbol, v]) => ({ symbol, lastPrice: String(v), openPrice: String(v) })) };
    const ms = msOf(u.searchParams.get('interval')), lim = +u.searchParams.get('limit'); const end = Math.floor(FAKE_NOW / ms) * ms;
    return { ok: true, json: async () => Array.from({ length: lim }, (_, i) => { const t = end - (lim - 1 - i) * ms; const row = [t, '100', '110', '90', '105']; if (!omitVolume) row.push(String(volOf(t, ms))); return row; }) };
  };
  class FakeWS { static all = []; constructor() { FakeWS.all.push(this); } send() {} close() { this.onclose && this.onclose(); } }
  globalThis.WebSocket = FakeWS;
  const B = require('../.test-build/binance.js');
  const bm = new B.BinanceMarket(); await bm.init(); const ws = FakeWS.all[0];
  const k = (sym, t, v, c = 105) => ({ stream: sym.toLowerCase() + '@kline_1m', data: { e: 'kline', s: sym, k: { t, o: '100', h: String(c + 5), l: '90', c: String(c), v: String(v) } } });
  const send = m => ws.onmessage({ data: JSON.stringify(m) });
  const IDS = ['5m', '15m', '1h', '4h', '1d'];

  // REST rows carry volume (column 5), for 1m and higher intervals
  assert.strictEqual(bm.candlesFor('BTCUSDT', '1m').at(-1).v, PARTIAL); assert.strictEqual(bm.candlesFor('BTCUSDT', '1m').at(-2).v, volMin(curMin - MIN));
  for (const id of IDS) { await bm.loadTimeframe('BTCUSDT', id); const c = bm.candlesFor('BTCUSDT', id).at(-1); assert.strictEqual(c.v, volOf(c.t, msOf(id)), `REST volume ${id}`); }
  const before = Object.fromEntries(IDS.map(id => [id, bm.candlesFor('BTCUSDT', id).at(-1).v]));

  // the stream's volume is CUMULATIVE for the minute: 3 (REST) -> 5 -> 8 -> 9 (final) must add only 6 in total
  send(k('BTCUSDT', curMin, 5)); send(k('BTCUSDT', curMin, 8)); send(k('BTCUSDT', curMin, 9));
  assert.strictEqual(bm.candlesFor('BTCUSDT', '1m').at(-1).v, 9, '1m shows the cumulative value');
  for (const id of IDS) {
    const c = bm.candlesFor('BTCUSDT', id).at(-1);
    assert.strictEqual(c.v, before[id] + 6, `${id}: +6, not +22 (summing cumulative values would double count)`);
    assert.strictEqual(c.v, volOf(c.t, msOf(id)) - PARTIAL + 9, `${id}: equals the sum of its 1m volumes`);
  }
  // a repeated identical message adds nothing
  send(k('BTCUSDT', curMin, 9)); for (const id of IDS) assert.strictEqual(bm.candlesFor('BTCUSDT', id).at(-1).v, before[id] + 6, `${id} unchanged by a repeat`);

  // next minute (11:00): new 5m/15m/1h candles start from that minute's own volume; 4h and 1d keep accumulating
  const m1 = curMin + MIN; const snap = Object.fromEntries(IDS.map(id => [id, bm.candlesFor('BTCUSDT', id).at(-1).v]));
  send(k('BTCUSDT', m1, 2)); send(k('BTCUSDT', m1, 6)); send(k('BTCUSDT', m1, 6));
  assert.strictEqual(bm.candlesFor('BTCUSDT', '1m').at(-1).t, m1); assert.strictEqual(bm.candlesFor('BTCUSDT', '1m').at(-1).v, 6);
  for (const id of ['5m', '15m', '1h']) {
    const l = bm.candlesFor('BTCUSDT', id); assert.strictEqual(l.at(-1).t, m1, `${id}: new bucket`); assert.strictEqual(l.at(-1).v, 6, `${id}: new bucket volume is this minute's only (2 -> 6)`);
    assert.strictEqual(l.at(-2).v, snap[id], `${id}: previous candle untouched`);
  }
  for (const id of ['4h', '1d']) assert.strictEqual(bm.candlesFor('BTCUSDT', id).at(-1).v, snap[id] + 6, `${id}: same bucket keeps accumulating`);

  // a glitchy lower cumulative value never reduces higher-timeframe volume (use ETH so BTC stays exact)
  await bm.loadTimeframe('ETHUSDT', '1h'); const e0 = bm.candlesFor('ETHUSDT', '1h').at(-1).v;
  send(k('ETHUSDT', curMin, 9)); const e1 = bm.candlesFor('ETHUSDT', '1h').at(-1).v; assert.strictEqual(e1, e0 + 6);
  send(k('ETHUSDT', curMin, 4)); assert.strictEqual(bm.candlesFor('ETHUSDT', '1h').at(-1).v, e1, 'volume went down in the feed -> HTF volume does not');

  // rows with no volume column parse fine and simply have no volume
  omitVolume = true; const bm2 = new B.BinanceMarket(); await bm2.init(); assert.ok(bm2.candlesFor('BTCUSDT', '1m').every(c => c.v === undefined)); bm2.dispose();
  const noV = { stream: 'btcusdt@kline_1m', data: { e: 'kline', s: 'BTCUSDT', k: { t: m1 + MIN, o: '1', h: '2', l: '1', c: '2' } } }; send(noV);
  assert.strictEqual(bm.candlesFor('BTCUSDT', '1m').at(-1).v, undefined, 'a stream message without volume gives a candle without volume');
  bm.dispose();

  // ───────── simulated feed ─────────
  const sim = new E.Market();
  for (const ins of E.UNIVERSE) { const l = sim.candles[ins.sym]; assert(l.every(c => Number.isFinite(c.v) && c.v > 0), `${ins.sym}: every history candle has positive finite volume`); }
  const sizeBefore = sim.candles.AAPL.length, histMean = sim.candles.AAPL.reduce((s, c) => s + c.v, 0) / sizeBefore;
  let lastV = sim.candles.AAPL.at(-1).v; for (let i = 0; i < 3; i++) { sim.tick(); const nv = sim.candles.AAPL.at(-1).v; assert(nv >= lastV, 'volume accumulates within a candle'); lastV = nv; }
  for (let i = 0; i < 6 * 700; i++) sim.tick();
  const live = sim.candles.AAPL.slice(sizeBefore + 1, -1); assert(live.length > 600);
  assert(live.every(c => Number.isFinite(c.v) && c.v > 0), 'every live candle has volume, including freshly created ones');
  const liveMean = live.reduce((s, c) => s + c.v, 0) / live.length; const ratio = liveMean / histMean;
  assert(ratio > 0.8 && ratio < 1.25, `live candle volumes are on the same scale as history (ratio ${ratio.toFixed(2)})`);
  // volume follows movement: candles with bigger moves trade more
  const hist = sim.candles.AAPL.slice(0, sizeBefore - 1); const mv = c => Math.abs(Math.log(c.c / c.o)); const sorted = [...hist].sort((a, b) => mv(a) - mv(b)); const q = Math.floor(sorted.length / 4);
  const mean = a => a.reduce((s, c) => s + c.v, 0) / a.length; assert(mean(sorted.slice(-q)) > 1.3 * mean(sorted.slice(0, q)), 'big-move candles have clearly more volume than quiet ones');
  // aggregation of the simulated feed conserves volume
  const agg = sim.candlesFor('AAPL', '5m'); const raw = sim.candles.AAPL; assert(Math.abs(total(agg) - total(raw)) < 1e-6 * total(raw), 'sim 5m volume = sum of base candle volumes');
  const prices = new Set(E.UNIVERSE.map(i => Math.round(sim.candles[i.sym].reduce((s, c) => s + c.v, 0) / sim.candles[i.sym].length * i.start / 1e5))); assert(prices.size >= 1);

  console.log('volume tests passed');
})().catch(e => { console.error(e); process.exit(1); });
