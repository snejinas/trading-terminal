import type { BrowserContext } from "@playwright/test";

/**
 * A configurable fake of Binance's public market-data API (REST klines/ticker + the combined
 * WebSocket stream the app subscribes to), installed on a browser context.
 *
 * Everything is deterministic: history prices are a smooth wave of time, every minute trades 10
 * units of volume (optionally with one huge "spike" minute), and by default the live quotes and
 * order book are flat so slippage/fee numbers can be asserted exactly.
 *
 * The exchange's clock is FROZEN when the mock is installed: history ends at that minute and the
 * live candle stays in it until a test moves it on with `state.minuteShift`. So candle counts are
 * exact and a test can never straddle a real minute boundary.
 */

export const BASE_PRICES: Record<string, number> = {
  BTCUSDT: 68000,
  ETHUSDT: 2500,
  SOLUSDT: 160,
  BNBUSDT: 590,
  XRPUSDT: 0.52,
  DOGEUSDT: 0.15,
};

export const INTERVAL_MS: Record<string, number> = {
  "1m": 60e3,
  "5m": 300e3,
  "15m": 900e3,
  "1h": 3600e3,
  "4h": 14400e3,
  "1d": 86400e3,
};

const MIN = 60e3;

export interface MockOptions {
  /** Include volume (REST column 5, stream field `v`). false simulates a feed without volume. Default true. */
  volume?: boolean;
  /** Make one 1-minute candle this many minutes ago trade 100 instead of 10 (higher timeframes include it). */
  spikeMinutesAgo?: number;
  /** The "exchange" only has this many minutes of history (so scrolling back reaches a real start). Default: unlimited. */
  historyMinutes?: number;
  /** REST kline requests for these intervals fail (the request is aborted). */
  failIntervals?: string[];
  /** Delay (ms) before answering kline requests for an interval. */
  slowIntervals?: Record<string, number>;
  /**
   * Order book shape. Level i is at price ± (0.5 + i·step), each holding `size` units.
   * `stepFraction` makes the step a fraction of the price (0.001 = 10 bps per level); default step is 1.
   */
  depth?: { size?: string; stepFraction?: number };
  /** Live quotes: constant (default) or following the same wave as the history. */
  livePrice?: "flat" | "wave";
  /**
   * Shape of 1-minute history. "ramp": the candle k minutes from the (frozen) current minute is
   * open base+k, high base+k+1, low base+k-1, close base+k+0.5, so moving averages have closed forms
   * (the live candle itself closes at the flat base price). Other intervals always use the wave.
   * "zigzag": the 1-minute close k minutes from the current minute is base + [0, 2, 1][k mod 3] (so every
   * three minutes the price steps +2, -1, -1 going forward), open = close, high = close+1, low = close-1.
   */
  history?: "wave" | "ramp" | "zigzag";
}

export interface Mock {
  /** Kline requests seen, as `SYMBOL/interval` (suffix `/older` for backwards-paging requests). */
  requests: string[];
  state: {
    /** Add this many minutes to the live candle's time: moves the (frozen) exchange clock on to a new minute. */
    minuteShift: number;
  };
  /** Open time of the spike candle (if any). */
  spikeT: number | null;
  /** Requests for intervals other than 1m (the initial 1m load is not interesting). */
  higherTimeframeRequests(): string[];
  olderRequests(): string[];
}

export async function installMockBinance(context: BrowserContext, options: MockOptions = {}): Promise<Mock> {
  const o = { volume: true, livePrice: "flat" as const, ...options };
  const depthSize = o.depth?.size ?? "5.00000";
  const startedAt = Date.now();
  const originMs = o.historyMinutes === undefined ? null : Math.floor(startedAt / MIN) * MIN - o.historyMinutes * MIN;
  const spikeT = o.spikeMinutesAgo === undefined ? null : Math.floor(startedAt / MIN) * MIN - o.spikeMinutesAgo * MIN;

  const mock: Mock = {
    requests: [],
    state: { minuteShift: 0 },
    spikeT,
    higherTimeframeRequests: () => mock.requests.filter((r) => !/\/1m(\/older)?$/.test(r)),
    olderRequests: () => mock.requests.filter((r) => r.endsWith("/older")),
  };

  const wave = (sym: string, t: number) =>
    BASE_PRICES[sym] * (1 + 0.02 * Math.sin(t / (3600e3 * 7)) + 0.004 * Math.sin(t / (60e3 * 23)));
  const live = (sym: string) => (o.livePrice === "wave" ? wave(sym, Date.now()) : BASE_PRICES[sym]);
  // every minute trades 10, the spike minute 100; a bucket's volume is the sum of its minutes
  const volumeOf = (bucket: number, ms: number) =>
    (ms / MIN) * 10 + (spikeT !== null && bucket <= spikeT && spikeT < bucket + ms ? 90 : 0);

  await context.route("**/data-api.binance.vision/**", async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname.endsWith("/ticker/24hr")) {
      return route.fulfill({
        json: Object.entries(BASE_PRICES).map(([symbol, v]) => ({ symbol, lastPrice: String(live(symbol)), openPrice: String(v * 0.98) })),
      });
    }
    const sym = u.searchParams.get("symbol")!;
    const interval = u.searchParams.get("interval")!;
    const limit = Number(u.searchParams.get("limit"));
    const older = u.searchParams.has("endTime");
    mock.requests.push(`${sym}/${interval}${older ? "/older" : ""}`);
    if (o.failIntervals?.includes(interval)) return route.abort();
    const delay = o.slowIntervals?.[interval];
    if (delay) await new Promise((r) => setTimeout(r, delay));

    const ms = INTERVAL_MS[interval];
    const endTime = older ? Number(u.searchParams.get("endTime")) : startedAt;
    const floor = originMs ?? startedAt - 4000 * 86400e3;
    const rows: (string | number)[][] = [];
    for (let t = Math.floor(endTime / ms) * ms; rows.length < limit && t + ms > floor; t -= ms) {
      const p = wave(sym, t);
      const row: (string | number)[] =
        o.history === "zigzag" && interval === "1m"
          ? ((k: number, b: number) => {
              const c = b + [0, 2, 1][((k % 3) + 3) % 3];
              return [t, String(c), String(c + 1), String(c - 1), String(c)];
            })((t - Math.floor(startedAt / MIN) * MIN) / MIN, BASE_PRICES[sym])
          : o.history === "ramp" && interval === "1m"
          ? ((k: number, b: number) => [t, String(b + k), String(b + k + 1), String(b + k - 1), String(b + k + 0.5)])(
              (t - Math.floor(startedAt / MIN) * MIN) / MIN,
              BASE_PRICES[sym]
            )
          : [t, String(p), String(p * 1.0006), String(p * 0.9994), String(wave(sym, t + ms - 1))];
      if (o.volume) row.push(String(volumeOf(t, ms)));
      rows.unshift(row);
    }
    return route.fulfill({ json: rows });
  });

  await context.routeWebSocket(/data-stream\.binance\.vision/, (ws) => {
    const timer = setInterval(() => {
      for (const s of Object.keys(BASE_PRICES)) {
        const p = live(s);
        const t0 = Math.floor(startedAt / MIN) * MIN + mock.state.minuteShift * MIN;
        const name = s.toLowerCase();
        ws.send(JSON.stringify({ stream: `${name}@bookTicker`, data: { s, b: String(p - 0.5), a: String(p + 0.5) } }));
        const k: Record<string, string | number> = { t: t0, o: String(p), h: String(p * 1.0002), l: String(p * 0.9998), c: String(p) };
        if (o.volume) k.v = "10";
        ws.send(JSON.stringify({ stream: `${name}@kline_1m`, data: { e: "kline", s, k } }));
        const step = o.depth?.stepFraction ? p * o.depth.stepFraction : 1;
        const level = (dir: number) => Array.from({ length: 10 }, (_, i) => [(p + dir * (0.5 + i * step)).toFixed(2), depthSize]);
        ws.send(JSON.stringify({ stream: `${name}@depth10@100ms`, data: { lastUpdateId: 1, bids: level(-1), asks: level(1) } }));
      }
    }, 300);
    ws.onClose(() => clearInterval(timer));
  });

  return mock;
}

/** Binance unreachable: the app falls back to its simulated feed. */
export async function blockBinance(context: BrowserContext): Promise<void> {
  await context.route("**/data-api.binance.vision/**", (route) => route.abort());
}
