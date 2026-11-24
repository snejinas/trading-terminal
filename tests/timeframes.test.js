process.env.TZ = 'UTC';
const assert = require('assert');
const T = require('../.test-build/timeframes.js');
const E = require('../.test-build/engine.js');
const near = (a, b, m, eps = 1e-9) => assert(Math.abs(a - b) < eps, `${m}: ${a} vs ${b}`);
const C = (t, o, h, l, c) => ({ t, o, h, l, c });

(async () => {
  // ── 1) interval tables ──
  const API = new Set(['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1M']);
  for (const t of T.BINANCE_TIMEFRAMES) assert(API.has(t.id), 'valid Binance interval: ' + t.id);
  for (const list of [T.BINANCE_TIMEFRAMES, T.SIM_TIMEFRAMES]) {
    assert.strictEqual(new Set(list.map(t => t.id)).size, list.length, 'unique ids');
    for (let i = 1; i < list.length; i++) assert(list[i].ms > list[i - 1].ms, 'finest first');
  }
  assert.deepStrictEqual(T.BINANCE_TIMEFRAMES.map(t => t.ms), [60e3, 300e3, 900e3, 3600e3, 14400e3, 86400e3]);

  // ── 2) bucket alignment is UTC-epoch aligned (matches Binance candle opens) ──
  const t0 = Date.UTC(2026, 10, 24, 9, 5, 30);
  assert.strictEqual(T.bucketStart(t0, 3600e3), Date.UTC(2026, 10, 24, 9, 0));
  assert.strictEqual(T.bucketStart(t0, 4 * 3600e3), Date.UTC(2026, 10, 24, 8, 0));
  assert.strictEqual(T.bucketStart(t0, 86400e3), Date.UTC(2026, 10, 24, 0, 0));
  assert.strictEqual(T.bucketStart(t0, 15 * 60e3), Date.UTC(2026, 10, 24, 9, 0));

  // ── 3) aggregateByTime ──
  const base = [C(0, 10, 12, 9, 11), C(1000, 11, 15, 10, 14), C(2000, 14, 14, 8, 9), C(3000, 9, 20, 9, 19), C(4000, 19, 19, 5, 6)];
  assert.deepStrictEqual(T.aggregateByTime(base, 3000), [C(0, 10, 15, 8, 9), C(3000, 9, 20, 5, 6)]);
  assert.deepStrictEqual(T.aggregateByTime(base, 1000), base.map(c => ({ ...c })));
  assert.deepStrictEqual(T.aggregateByTime([], 3000), []);
  const before = JSON.stringify(base); T.aggregateByTime(base, 3000); assert.strictEqual(JSON.stringify(base), before, 'does not mutate input');
  // appending base candles never changes already-complete earlier buckets (stable chart)
  const a1 = T.aggregateByTime(base.slice(0, 3), 3000); const a2 = T.aggregateByTime(base, 3000);
  assert.deepStrictEqual(a1[0], a2[0]);

  // ── 4) foldCandle ──
  const H = 3600e3; const hr = Date.UTC(2026, 10, 24, 9);
  let list = [C(hr - H, 100, 110, 95, 105), C(hr, 105, 108, 104, 107)];
  T.foldCandle(list, H, C(hr + 60e3 * 7, 107, 112, 106, 111));              // same hour: widens high, close tracks
  assert.deepStrictEqual(list[1], C(hr, 105, 112, 104, 111));
  T.foldCandle(list, H, C(hr + 60e3 * 8, 111, 111, 101, 102));              // lower low, lower close
  assert.deepStrictEqual(list[1], C(hr, 105, 112, 101, 102));
  T.foldCandle(list, H, C(hr + 60e3 * 8, 102, 103, 102, 103));              // in-progress repeat never narrows h/l
  assert.strictEqual(list[1].h, 112); assert.strictEqual(list[1].l, 101); assert.strictEqual(list[1].c, 103);
  T.foldCandle(list, H, C(hr + H, 103, 104, 103, 104));                     // next hour opens a new candle at its 1m open
  assert.strictEqual(list.length, 3); assert.deepStrictEqual(list[2], C(hr + H, 103, 104, 103, 104));
  T.foldCandle(list, H, C(hr + 5 * 60e3, 1, 999, 0, 1));                    // stale (older bucket): ignored
  assert.strictEqual(list.length, 3); assert.strictEqual(list[1].h, 112); assert.strictEqual(list[2].c, 104);
  const lst = []; T.foldCandle(lst, H, C(hr, 1, 2, 0.5, 1.5)); assert.strictEqual(lst.length, 1, 'works on an empty list');
  const big = Array.from({ length: 5 }, (_, i) => C(hr + (i - 5) * H, 1, 1, 1, 1));
  T.foldCandle(big, H, C(hr, 1, 1, 1, 1), 5); assert.strictEqual(big.length, 5, 'trimmed to max'); assert.strictEqual(big[4].t, hr);

  // ── 5) time labels (TZ=UTC here) ──
  assert.strictEqual(T.formatAxisTime(t0, 60e3), '09:05');
  assert.strictEqual(T.formatAxisTime(t0, 3e3), '09:05:30');
  assert.strictEqual(T.formatAxisTime(t0, 3600e3), '11/24 09:05');
  assert.strictEqual(T.formatAxisTime(t0, 86400e3), '11-24');
  assert.strictEqual(T.formatFullTime(t0, 60e3), '2026-11-24 09:05');
  assert.strictEqual(T.formatFullTime(t0, 3e3), '2026-11-24 09:05:30');
  assert.strictEqual(T.formatFullTime(t0, 86400e3), '2026-11-24 UTC');

  // ── 6) simulated feed aggregates its base candles ──
  const sim = new E.Market();
  assert(sim.timeframes.some(t => t.id === sim.defaultTimeframe));
  const b3 = sim.candlesFor('AAPL', '3s'); assert(b3.length >= 3600, 'history'); assert.strictEqual(b3, sim.candles['AAPL'], '3s is the base list');
  const m5 = sim.candlesFor('AAPL', '5m'); assert(m5.length >= 30 && m5.length <= 40, 'about 3h of 5m candles: ' + m5.length);
  for (const c of m5) { assert(c.h >= Math.max(c.o, c.c) && c.l <= Math.min(c.o, c.c)); assert.strictEqual(c.t % 300e3, 0); }
  // a full 5m candle equals the aggregate of its base candles
  const mid = m5[10]; const inB = b3.filter(c => T.bucketStart(c.t, 300e3) === mid.t);
  near(mid.o, inB[0].o, 'o'); near(mid.c, inB[inB.length - 1].c, 'c'); near(mid.h, Math.max(...inB.map(c => c.h)), 'h'); near(mid.l, Math.min(...inB.map(c => c.l)), 'l');
  assert.deepStrictEqual(sim.candlesFor('AAPL', 'nope'), []);
  for (let i = 0; i < 40; i++) sim.tick();
  const last5 = sim.candlesFor('AAPL', '5m').at(-1); near(last5.c, sim.price['AAPL'], 'live close tracks price'); assert(last5.h >= sim.price['AAPL'] && last5.l <= sim.price['AAPL']);
  await sim.loadTimeframe('AAPL', '5m');

  // ── 7) BinanceMarket with fake fetch + WebSocket ──
  const calls = []; let failNext = 0;
  const NOW = Date.now(); const bases = { BTCUSDT: 68000, ETHUSDT: 2500, SOLUSDT: 160, BNBUSDT: 590, XRPUSDT: 0.52, DOGEUSDT: 0.15 };
  const msOf = id => ({ '1m': 60e3, '5m': 300e3, '15m': 900e3, '1h': 3600e3, '4h': 14400e3, '1d': 86400e3 })[id];
  globalThis.fetch = async url => {
    calls.push(String(url)); const u = new URL(url);
    if (failNext > 0 && u.pathname.endsWith('/klines')) { failNext--; return { ok: false, status: 503, json: async () => ({}) }; }
    if (u.pathname.endsWith('/ticker/24hr')) return { ok: true, json: async () => Object.entries(bases).map(([symbol, v]) => ({ symbol, lastPrice: String(v), openPrice: String(v) })) };
    const sym = u.searchParams.get('symbol'), ms = msOf(u.searchParams.get('interval')), lim = +u.searchParams.get('limit');
    const end = Math.floor(NOW / ms) * ms; const v = bases[sym];
    return { ok: true, json: async () => Array.from({ length: lim === 300 ? 300 : lim }, (_, i) => { const t = end - (lim - 1 - i) * ms; return [t, String(v), String(v + 10), String(v - 10), String(v + 1)]; }) };
  };
  class FakeWS { static all = []; constructor(url) { this.url = url; FakeWS.all.push(this); } send() {} close() { this.onclose && this.onclose(); } open() { this.onopen && this.onopen(); } emit(o) { this.onmessage({ data: JSON.stringify(o) }); } }
  globalThis.WebSocket = FakeWS;
  const B = require('../.test-build/binance.js');
  const bm = new B.BinanceMarket(); await bm.init();
  const ws = FakeWS.all[0]; ws.open();
  assert(/kline_1m/.test(ws.url) && /depth10/.test(ws.url));
  const n0 = calls.length;
  assert.strictEqual(bm.defaultTimeframe, '1m'); assert.strictEqual(bm.candlesFor('BTCUSDT', '1m').length, 200); assert.deepStrictEqual(bm.candlesFor('BTCUSDT', '1h'), []);

  // lazy load: right URL, cached, concurrent calls share one request
  await Promise.all([bm.loadTimeframe('BTCUSDT', '1h'), bm.loadTimeframe('BTCUSDT', '1h')]);
  const klineCalls = () => calls.slice(n0).filter(u => /interval=1h/.test(u) && /symbol=BTCUSDT/.test(u));
  assert.strictEqual(klineCalls().length, 1, 'one request for concurrent loads'); assert(/interval=1h&limit=300/.test(klineCalls()[0]));
  await bm.loadTimeframe('BTCUSDT', '1h'); assert.strictEqual(klineCalls().length, 1, 'cached');
  const h1 = bm.candlesFor('BTCUSDT', '1h'); assert.strictEqual(h1.length, 300); assert.strictEqual(bm.candlesFor('ETHUSDT', '1h').length, 0, 'other symbols not loaded');
  await bm.loadTimeframe('BTCUSDT', '1m'); // no-op, no fetch
  assert.strictEqual(calls.slice(n0).filter(u => /interval=1m/.test(u) && /BTCUSDT/.test(u)).length, 0);
  await assert.rejects(bm.loadTimeframe('BTCUSDT', '2h'), /Unknown timeframe/); await assert.rejects(bm.loadTimeframe('NOPE', '1h'), /Unknown symbol/);

  // live fold from the 1m stream (current hour bucket = last 1h candle)
  const lastH = h1.at(-1), hOpen = lastH.t;
  const k = (t, o, h, l, c) => ({ stream: 'btcusdt@kline_1m', data: { e: 'kline', s: 'BTCUSDT', k: { t, o: String(o), h: String(h), l: String(l), c: String(c) } } });
  ws.emit(k(hOpen + 60e3 * 3, 68001, 68050, 67995, 68040));
  assert.strictEqual(lastH.h, 68050, 'high widened'); assert.strictEqual(lastH.c, 68040, 'close tracks'); assert.strictEqual(lastH.l, 67990, 'low (68000-10) not narrowed by a higher low');
  ws.emit(k(hOpen + 60e3 * 4, 68040, 68041, 67900, 67950)); assert.strictEqual(lastH.l, 67900); assert.strictEqual(lastH.c, 67950);
  ws.emit(k(hOpen + 3600e3, 67950, 67960, 67940, 67955));   // next hour starts
  assert.strictEqual(bm.candlesFor('BTCUSDT', '1h').length, 301, 'new hour appended (cap is 600)'); const nh = bm.candlesFor('BTCUSDT', '1h').at(-1);
  assert.strictEqual(nh.t, hOpen + 3600e3); assert.strictEqual(nh.o, 67950); assert.strictEqual(nh.c, 67955);
  assert.strictEqual(bm.candlesFor('BTCUSDT', '1m').at(-1).c, 67955, '1m list also updated'); assert.strictEqual(bm.price.BTCUSDT, 67955);
  assert.strictEqual(bm.candlesFor('ETHUSDT', '1h').length, 0, 'unloaded timeframes are not built');

  // every interval folds on its own UTC-aligned bucket
  for (const id of ['5m', '15m', '4h', '1d']) {
    await bm.loadTimeframe('BTCUSDT', id); const l = bm.candlesFor('BTCUSDT', id); assert.strictEqual(l.length, 300, id);
    const tt = l.at(-1).t + msOf(id) - 60e3; // last minute of the current bucket
    ws.emit(k(tt, 1, 70000, 1, 69999)); assert.strictEqual(bm.candlesFor('BTCUSDT', id).at(-1).c, 69999, id); assert.strictEqual(bm.candlesFor('BTCUSDT', id).at(-1).h, 70000, id);
  }

  // failed REST: rejects, nothing cached, a retry works
  failNext = 1; await assert.rejects(bm.loadTimeframe('ETHUSDT', '1h'), /Binance 503/); assert.strictEqual(bm.candlesFor('ETHUSDT', '1h').length, 0);
  await bm.loadTimeframe('ETHUSDT', '1h'); assert.strictEqual(bm.candlesFor('ETHUSDT', '1h').length, 300, 'retry succeeds');

  // reconnect re-syncs loaded timeframes
  const preRefresh = calls.filter(u => /interval=1h/.test(u)).length;
  ws.close(); await new Promise(r => setTimeout(r, 2300));
  assert.strictEqual(FakeWS.all.length, 2, 'reconnected'); FakeWS.all[1].open(); await new Promise(r => setTimeout(r, 100));
  assert(calls.filter(u => /interval=1h/.test(u)).length >= preRefresh + 2, 'loaded 1h timeframes (BTC, ETH) were re-fetched after reconnect');
  bm.dispose();

  console.log('timeframe tests passed');
})().catch(e => { console.error(e); process.exit(1); });
