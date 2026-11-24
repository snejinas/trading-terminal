process.env.TZ = 'UTC';
const assert = require('assert');
const V = require('../.test-build/chartview.js');
const T = require('../.test-build/timeframes.js');
const E = require('../.test-build/engine.js');
const near = (a, b, m, eps = 1e-9) => assert(Math.abs(a - b) < eps, `${m}: ${a} vs ${b}`);
const C = (t, o = 1, h = 2, l = 0.5, c = 1.5) => ({ t, o, h, l, c });
const series = (n, t0 = 0, ms = 60e3) => Array.from({ length: n }, (_, i) => C(t0 + i * ms));

(async () => {
  // ───────── view math ─────────
  // defaults and clamping
  assert.strictEqual(V.defaultCount(300), 37); assert.strictEqual(V.defaultCount(50), 20); assert.strictEqual(V.defaultCount(5000), 90);
  assert.strictEqual(V.resolveCount({ count: null, offset: 0 }, 800), 90); assert.strictEqual(V.resolveCount({ count: 3, offset: 0 }, 800), V.MIN_COUNT); assert.strictEqual(V.resolveCount({ count: 99999, offset: 0 }, 800), V.MAX_COUNT);
  assert.strictEqual(V.resolveCount({ count: 40.4, offset: 0 }, 800), 40);
  // scroll limits: 0 .. len - quarter window; garbage is safe
  assert.strictEqual(V.maxOffset(1000, 100), 975); assert.strictEqual(V.maxOffset(10, 100), 0, 'short history cannot scroll'); assert.strictEqual(V.maxOffset(0, 100), 0);
  for (const bad of [NaN, Infinity, -Infinity, -50]) assert(V.clampOffset(bad, 100, 1000) >= 0 && V.clampOffset(bad, 100, 1000) <= 975);
  assert.strictEqual(V.clampOffset(5000, 100, 1000), 975); assert.strictEqual(V.clampOffset(-3, 100, 1000), 0);
  assert.strictEqual(V.windowStart(1000, 0, 100), 900, 'live edge shows the newest 100'); assert.strictEqual(V.windowStart(1000, 40, 100), 860);
  assert.strictEqual(V.windowStart(30, 0, 90), -60, 'short history leaves empty slots at the left');

  // zoom keeps the candle under the cursor where it is (the property that makes zoom feel right)
  const len = 1000;
  for (const [offset, count, f, factor] of [[0, 90, 0.5, 0.5], [0, 90, 0.5, 2], [120, 90, 0.2, 0.7], [120, 90, 0.9, 1.6], [300, 200, 0, 0.5], [300, 200, 1, 3], [37.5, 60, 0.33, 1.25]]) {
    const before = V.windowStart(len, offset, count) + f * count;
    const r = V.zoomAt({ count, offset }, count, len, f, factor);
    const after = V.windowStart(len, r.offset, r.count) + f * r.count;
    // the unclamped offset that would keep the anchor exactly in place:
    const want = len - before - (1 - f) * r.count;
    const lo = 0, hi = V.maxOffset(len, r.count);
    near(r.offset, Math.min(Math.max(want, lo), hi), `offset is the anchor-preserving one, clamped to [0, max] (off ${offset}, ${count}, f ${f}, x${factor})`, 1e-9);
    if (want >= lo && want <= hi) near(after, before, `anchor stable when not clamped (off ${offset}, ${count}, f ${f}, x${factor})`, 0.6 /* count is rounded to whole candles */);
    assert(r.count >= V.MIN_COUNT && r.count <= V.MAX_COUNT);
  }
  { // zoom-out at the live edge cannot go past it: the window grows to the left instead
    const r = V.zoomAt({ count: 90, offset: 0 }, 90, len, 0.5, 2); assert.strictEqual(r.offset, 0); assert.strictEqual(r.count, 180); }
  { // zoom-in while scrolled back keeps the candle under the cursor exactly (no clamping involved)
    const f = 0.3, off = 200, cnt = 100, before = V.windowStart(len, off, cnt) + f * cnt; const r = V.zoomAt({ count: cnt, offset: off }, cnt, len, f, 0.5);
    near(V.windowStart(len, r.offset, r.count) + f * r.count, before, 'exact anchor', 1e-9); assert.strictEqual(r.count, 50); }
  // zooming in/out direction
  assert(V.zoomAt({ count: 90, offset: 0 }, 90, len, 0.5, 0.5).count < 90, 'factor<1 zooms in'); assert(V.zoomAt({ count: 90, offset: 0 }, 90, len, 0.5, 2).count > 90, 'factor>1 zooms out');
  // limits + no-ops
  assert.strictEqual(V.zoomAt({ count: V.MIN_COUNT, offset: 0 }, V.MIN_COUNT, len, 0.5, 0.1).count, V.MIN_COUNT);
  assert.strictEqual(V.zoomAt({ count: V.MAX_COUNT, offset: 0 }, V.MAX_COUNT, len, 0.5, 9).count, V.MAX_COUNT);
  for (const f of [NaN, -1, 0]) assert.strictEqual(V.zoomAt({ count: 90, offset: 5 }, 90, len, 0.5, f).count, 90, 'bad factor is a no-op');
  assert.strictEqual(V.zoomAt({ count: 90, offset: 5 }, 90, len, NaN, 0.5).count, 45, 'bad anchor falls back to the right edge');
  // zooming at the live edge keeps you at the live edge when anchored to the right
  assert.strictEqual(V.zoomAt({ count: 90, offset: 0 }, 90, len, 1, 0.5).offset, 0);
  // a zoom can never leave the scroll range
  const z = V.zoomAt({ count: 100, offset: 975 }, 100, len, 0.1, 6); assert(z.offset <= V.maxOffset(len, z.count) && z.offset >= 0);

  // new candles at the right: count them so the window can stay anchored in time
  const all = series(100); assert.strictEqual(V.appendedSince(all, all[99].t), 0); assert.strictEqual(V.appendedSince(all, all[96].t), 3); assert.strictEqual(V.appendedSince(all, -1), 100); assert.strictEqual(V.appendedSince([], 5), 0);
  // ...and prepending older history (at the left) must not move a right-anchored window
  const before = V.windowStart(100, 10, 40); const after = V.windowStart(600, 10, 40) - 500; assert.strictEqual(before, after, 'prepend does not shift the window relative to the data');

  // ───────── history merge helpers ─────────
  const ex = series(10, 1000 * 60e3), older = series(5, 990 * 60e3);
  assert.deepStrictEqual(T.olderThan(ex, older).map(c => c.t), older.map(c => c.t), 'older candles pass through, sorted');
  assert.deepStrictEqual(T.olderThan(ex, [...older].reverse()).map(c => c.t), older.map(c => c.t), 'sorted even if given newest-first');
  assert.strictEqual(T.olderThan(ex, [C(1000 * 60e3), C(1005 * 60e3)]).length, 0, 'overlap with held candles is dropped');
  assert.strictEqual(T.olderThan([], older).length, 5);
  // mergeLatest keeps old history, replaces the overlapping tail with fresh data, respects max
  const have = series(20, 0), fresh = series(8, 15 * 60e3).map(c => ({ ...c, c: 99 }));
  const merged = T.mergeLatest(have, fresh); assert.strictEqual(merged.length, 15 + 8); assert.deepStrictEqual(merged.slice(0, 15).map(c => c.t), have.slice(0, 15).map(c => c.t)); assert(merged.slice(15).every(c => c.c === 99));
  assert.strictEqual(T.mergeLatest(have, []), have, 'nothing fresh -> unchanged');
  assert.strictEqual(T.mergeLatest(series(50), series(10, 45 * 60e3), 30).length, 30); assert.strictEqual(T.mergeLatest(series(50), series(10, 45 * 60e3), 30).at(-1).t, 54 * 60e3);
  for (let i = 1; i < merged.length; i++) assert(merged[i].t > merged[i - 1].t, 'strictly increasing');

  // ───────── BinanceMarket.loadOlder against a fake exchange with a start-of-market ─────────
  const calls = []; let failOlder = 0;
  const NOW = Date.now(), MIN = 60e3; const ORIGIN_MINS = 1500;       // exchange only has 1500 minutes of 1m history
  const msOf = id => ({ '1m': 60e3, '5m': 300e3, '15m': 900e3, '1h': 3600e3, '4h': 14400e3, '1d': 86400e3 })[id];
  const bases = { BTCUSDT: 68000, ETHUSDT: 2500, SOLUSDT: 160, BNBUSDT: 590, XRPUSDT: 0.52, DOGEUSDT: 0.15 };
  const originOf = id => Math.floor(NOW / MIN) * MIN - ORIGIN_MINS * MIN;      // same origin instant for every interval
  globalThis.fetch = async url => {
    calls.push(String(url)); const u = new URL(url);
    if (u.pathname.endsWith('/ticker/24hr')) return { ok: true, json: async () => Object.entries(bases).map(([symbol, v]) => ({ symbol, lastPrice: String(v), openPrice: String(v) })) };
    const id = u.searchParams.get('interval'), sym = u.searchParams.get('symbol'), lim = +u.searchParams.get('limit'), ms = msOf(id);
    const endTime = u.searchParams.get('endTime') ? +u.searchParams.get('endTime') : NOW;
    if (u.searchParams.get('endTime') && failOlder > 0) { failOlder--; return { ok: false, status: 500, json: async () => ({}) }; }
    const origin = originOf(id); const rows = [];
    for (let t = Math.floor(endTime / ms) * ms; rows.length < lim && t >= origin - (ms - 1); t -= ms) if (t + ms > origin) rows.unshift([t, '100', '110', '90', '105']);
    return { ok: true, json: async () => rows };
  };
  class FakeWS { static all = []; constructor(u) { FakeWS.all.push(this); } send() {} close() { this.onclose && this.onclose(); } }
  globalThis.WebSocket = FakeWS;
  const B = require('../.test-build/binance.js');
  const bm = new B.BinanceMarket(); await bm.init(); const ws = FakeWS.all[0];
  const ascending = l => l.every((c, i) => i === 0 || c.t > l[i - 1].t);
  const noDupes = l => new Set(l.map(c => c.t)).size === l.length;

  const n0 = bm.candlesFor('BTCUSDT', '1m').length; assert.strictEqual(n0, 200);
  const oldest0 = bm.candlesFor('BTCUSDT', '1m')[0].t;
  // concurrent requests share one fetch
  const callsBefore = calls.length;
  const [r1, r1b] = await Promise.all([bm.loadOlder('BTCUSDT', '1m'), bm.loadOlder('BTCUSDT', '1m')]);
  assert.strictEqual(calls.length - callsBefore, 1, 'one request for concurrent loadOlder'); assert.deepStrictEqual(r1, r1b);
  assert(/endTime=/.test(calls.at(-1)) && /limit=500/.test(calls.at(-1)));
  assert.strictEqual(+new URL(calls.at(-1)).searchParams.get('endTime'), oldest0 - 1, 'asks for candles strictly before the oldest we hold');
  assert.deepStrictEqual(r1, { added: 500, done: false });
  let l = bm.candlesFor('BTCUSDT', '1m'); assert.strictEqual(l.length, 700); assert(ascending(l) && noDupes(l)); assert.strictEqual(l.at(-1).t, Math.floor(NOW / MIN) * MIN, 'newest unchanged');
  // keep going until the start of the market: 200 + 500 + 500 + 301 = 1501 (origin minute + 1500), then done
  const r2 = await bm.loadOlder('BTCUSDT', '1m'); assert.deepStrictEqual(r2, { added: 500, done: false });
  const r3 = await bm.loadOlder('BTCUSDT', '1m'); assert.deepStrictEqual(r3, { added: 301, done: true }, 'short page = start of market');
  l = bm.candlesFor('BTCUSDT', '1m'); assert.strictEqual(l.length, 1501); assert(ascending(l) && noDupes(l)); assert.strictEqual(l[0].t, originOf('1m'));
  const c2 = calls.length; assert.deepStrictEqual(await bm.loadOlder('BTCUSDT', '1m'), { added: 0, done: true }); assert.strictEqual(calls.length, c2, 'once exhausted, no more requests');
  // other symbols are independent
  assert.strictEqual(bm.candlesFor('ETHUSDT', '1m').length, 200); assert.deepStrictEqual(await bm.loadOlder('ETHUSDT', '1m'), { added: 500, done: false });

  // live updates still land on the right candle after history was prepended
  const k = (t, c) => ({ stream: 'btcusdt@kline_1m', data: { e: 'kline', s: 'BTCUSDT', k: { t, o: '1', h: String(c + 1), l: '0.5', c: String(c) } } });
  const newestT = bm.candlesFor('BTCUSDT', '1m').at(-1).t; ws.onmessage({ data: JSON.stringify(k(newestT, 777)) });
  assert.strictEqual(bm.candlesFor('BTCUSDT', '1m').at(-1).c, 777); assert.strictEqual(bm.candlesFor('BTCUSDT', '1m').length, 1501);
  ws.onmessage({ data: JSON.stringify(k(newestT + MIN, 778)) }); assert.strictEqual(bm.candlesFor('BTCUSDT', '1m').length, 1502);

  // higher timeframes: load, then scroll back (needs the timeframe loaded first)
  assert.deepStrictEqual(await bm.loadOlder('SOLUSDT', '5m'), { added: 0, done: false }, 'nothing to extend before the timeframe is loaded');
  await bm.loadTimeframe('SOLUSDT', '5m'); assert.strictEqual(bm.candlesFor('SOLUSDT', '5m').length, 300);
  const h = await bm.loadOlder('SOLUSDT', '5m'); const hl = bm.candlesFor('SOLUSDT', '5m');
  assert(h.added >= 1 && h.done, JSON.stringify(h)); assert.strictEqual(hl.length, 300 + h.added); assert(ascending(hl) && noDupes(hl)); assert.strictEqual(hl[0].t, Math.floor(originOf('5m') / 300e3) * 300e3);
  // a timeframe whose full history already fit in the first page is complete straight away
  await bm.loadTimeframe('SOLUSDT', '1h'); const full = bm.candlesFor('SOLUSDT', '1h').length; assert(full > 20 && full < 300, 'exchange only has ~25h');
  assert.deepStrictEqual(await bm.loadOlder('SOLUSDT', '1h'), { added: 0, done: true }); assert.strictEqual(bm.candlesFor('SOLUSDT', '1h').length, full);
  await assert.rejects(bm.loadOlder('SOLUSDT', '2h'), /Unknown timeframe/);

  // failure: rejects, series untouched, NOT marked exhausted, retry works
  const bnb = bm.candlesFor('BNBUSDT', '1m').length; failOlder = 1;
  await assert.rejects(bm.loadOlder('BNBUSDT', '1m'), /Binance 500/); assert.strictEqual(bm.candlesFor('BNBUSDT', '1m').length, bnb);
  assert.deepStrictEqual(await bm.loadOlder('BNBUSDT', '1m'), { added: 500, done: false }, 'retry works');

  // reconnect resync keeps scrolled-back history (1m for every symbol + loaded timeframes)
  const btcBefore = bm.candlesFor('BTCUSDT', '1m').length; const oldestBefore = bm.candlesFor('BTCUSDT', '1m')[0].t;
  ws.close(); await new Promise(r => setTimeout(r, 2300)); FakeWS.all[1].onopen(); await new Promise(r => setTimeout(r, 150));
  const resynced = bm.candlesFor('BTCUSDT', '1m'); assert(resynced.length >= btcBefore - 1, `history kept: ${resynced.length} vs ${btcBefore}`); assert.strictEqual(resynced[0].t, oldestBefore, 'oldest candle still there'); assert(ascending(resynced) && noDupes(resynced));
  assert(bm.candlesFor('BNBUSDT', '1m').length >= 700, 'other symbols also keep their history');
  bm.dispose();

  // sim feed: nothing older to fetch
  const sim = new E.Market(); assert.deepStrictEqual(await sim.loadOlder('AAPL', '3s'), { added: 0, done: true });

  console.log('history tests passed');
})().catch(e => { console.error(e); process.exit(1); });
