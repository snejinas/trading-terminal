/**
 * Binance PUBLIC market data (no API key). Orders are still paper-traded locally.
 * Uses the market-data-only hosts, which work without credentials and are not
 * geo-restricted the way api.binance.com can be.
 */
import { ImpactBook, registerInstruments, type BookDepth, type Candle, type Feed, type Instrument, type Side } from "./engine";
import { BINANCE_TIMEFRAMES, foldCandle } from "./timeframes";

const REST = "https://data-api.binance.vision/api/v3";
const WS = "wss://data-stream.binance.vision/stream";

export const BINANCE_INSTRUMENTS: Instrument[] = [
  { sym: "BTCUSDT", name: "Bitcoin", start: 0, vol: 0, dp: 2 },
  { sym: "ETHUSDT", name: "Ethereum", start: 0, vol: 0, dp: 2 },
  { sym: "SOLUSDT", name: "Solana", start: 0, vol: 0, dp: 2 },
  { sym: "BNBUSDT", name: "BNB", start: 0, vol: 0, dp: 2 },
  { sym: "XRPUSDT", name: "XRP", start: 0, vol: 0, dp: 4 },
  { sym: "DOGEUSDT", name: "Dogecoin", start: 0, vol: 0, dp: 5 },
];

export class BinanceMarket implements Feed {
  instruments = BINANCE_INSTRUMENTS;
  price: Record<string, number> = {};
  open: Record<string, number> = {};
  candles: Record<string, Candle[]> = {};
  connected = false;
  timeframes = BINANCE_TIMEFRAMES;
  defaultTimeframe = "1m";
  /** Higher-timeframe candles, keyed `${sym}|${timeframeId}`. 1m lives in `candles`. */
  private tf: Record<string, Candle[]> = {};
  private pending = new Map<string, Promise<void>>();
  private everOpened = false;
  private books: Record<string, BookDepth> = {};
  private impact = new ImpactBook();
  private bids: Record<string, number> = {};
  private asks: Record<string, number> = {};
  private ws: WebSocket | null = null;
  private disposed = false;
  private retry: ReturnType<typeof setTimeout> | null = null;

  /** Load snapshot data over REST, then open the stream. Throws if REST fails. */
  async init(): Promise<void> {
    const syms = this.instruments.map((i) => i.sym);
    const [tickers, ...klines] = await Promise.all([
      fetchJson(`${REST}/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(syms))}&type=MINI`),
      ...syms.map((s) => fetchJson(`${REST}/klines?symbol=${s}&interval=1m&limit=200`)),
    ]);
    for (const t of tickers as { symbol: string; lastPrice: string; openPrice: string }[]) {
      this.price[t.symbol] = parseFloat(t.lastPrice);
      this.open[t.symbol] = parseFloat(t.openPrice);
    }
    syms.forEach((s, i) => {
      this.candles[s] = (klines[i] as (string | number)[][]).map(toCandle);
      const spread = this.price[s] * 0.0001;
      this.bids[s] = this.price[s] - spread / 2;
      this.asks[s] = this.price[s] + spread / 2;
    });
    registerInstruments(this.instruments);
    this.connect();
  }

  private connect(): void {
    if (this.disposed) return;
    const streams = this.instruments
      .flatMap((i) => [
        `${i.sym.toLowerCase()}@bookTicker`,
        `${i.sym.toLowerCase()}@kline_1m`,
        `${i.sym.toLowerCase()}@depth10@100ms`, // top-10 levels, full snapshot each push
      ])
      .join("/");
    const ws = new WebSocket(`${WS}?streams=${streams}`);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      // After a reconnect we may have missed updates: re-sync every higher timeframe we hold.
      if (this.everOpened) void this.refreshLoaded();
      this.everOpened = true;
    };
    ws.onclose = () => {
      this.connected = false;
      if (!this.disposed) this.retry = setTimeout(() => this.connect(), 2000);
    };
    ws.onerror = () => ws.close();
    ws.onmessage = (ev) => {
      let msg: { stream?: string; data?: any };
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      const d = msg.data;
      if (!d) return;
      if (Array.isArray(d.bids) && Array.isArray(d.asks) && msg.stream) {
        const s = msg.stream.split("@")[0].toUpperCase();
        const lv = (a: string[][]) => a.map(([p, q]) => [+p, +q] as [number, number]);
        this.books[s] = { bids: lv(d.bids), asks: lv(d.asks) };
      } else if (d.e === "kline") {
        const s: string = d.s;
        const k = d.k;
        const c = toCandle([k.t, k.o, k.h, k.l, k.c]);
        const list = this.candles[s];
        if (!list) return;
        const last = list[list.length - 1];
        if (last && last.t === c.t) list[list.length - 1] = c;
        else {
          list.push(c);
          if (list.length > 400) list.shift();
        }
        this.price[s] = c.c;
        // keep every loaded higher timeframe live by folding the 1m update into it
        for (const key of Object.keys(this.tf)) {
          if (!key.startsWith(s + "|")) continue;
          const tfm = this.timeframes.find((t) => t.id === key.slice(s.length + 1));
          if (tfm) foldCandle(this.tf[key], tfm.ms, c);
        }
      } else if (d.b !== undefined && d.a !== undefined && d.s) {
        // bookTicker: best bid / ask
        this.bids[d.s] = parseFloat(d.b);
        this.asks[d.s] = parseFloat(d.a);
      }
    };
  }

  tick(): void {}

  candlesFor(sym: string, timeframeId: string): Candle[] {
    return timeframeId === "1m" ? (this.candles[sym] ?? []) : (this.tf[`${sym}|${timeframeId}`] ?? []);
  }

  /** Fetch history for a timeframe (once; concurrent calls share one request). 1m is always loaded. */
  async loadTimeframe(sym: string, timeframeId: string): Promise<void> {
    if (!this.timeframes.some((t) => t.id === timeframeId)) throw new Error(`Unknown timeframe ${timeframeId}`);
    if (!this.price[sym]) throw new Error(`Unknown symbol ${sym}`);
    if (timeframeId === "1m") return;
    const key = `${sym}|${timeframeId}`;
    if (this.tf[key]) return;
    let p = this.pending.get(key);
    if (!p) {
      p = this.fetchKlines(sym, timeframeId)
        .then((rows) => {
          this.tf[key] = rows;
        })
        .finally(() => this.pending.delete(key));
      this.pending.set(key, p);
    }
    await p;
  }

  private async fetchKlines(sym: string, timeframeId: string): Promise<Candle[]> {
    const rows = (await fetchJson(`${REST}/klines?symbol=${sym}&interval=${timeframeId}&limit=300`)) as (string | number)[][];
    return rows.map(toCandle);
  }

  private async refreshLoaded(): Promise<void> {
    await Promise.all(
      Object.keys(this.tf).map(async (key) => {
        const [sym, id] = key.split("|");
        try {
          this.tf[key] = await this.fetchKlines(sym, id);
        } catch {
          /* keep the stale candles; the 1m stream keeps folding into them */
        }
      })
    );
  }
  /** Latest Binance snapshot minus liquidity our own fills have consumed and not yet recovered. */
  depth(sym: string): BookDepth | null {
    const raw = this.books[sym];
    return raw ? this.impact.adjust(sym, raw) : null;
  }
  consume(sym: string, side: Side, taken: [number, number][]): void {
    this.impact.consume(sym, side, taken);
  }
  impactActive(sym: string): boolean {
    return this.impact.has(sym);
  }
  // While our fills have depleted the book, the effective touch is the first level with size left.
  bid(sym: string): number {
    if (this.impact.has(sym)) {
      const b = this.depth(sym)?.bids[0];
      if (b) return b[0];
    }
    return this.bids[sym] ?? this.price[sym];
  }
  ask(sym: string): number {
    if (this.impact.has(sym)) {
      const a = this.depth(sym)?.asks[0];
      if (a) return a[0];
    }
    return this.asks[sym] ?? this.price[sym];
  }
  spread(sym: string): number {
    return Math.max(this.ask(sym) - this.bid(sym), this.price[sym] * 1e-6);
  }
  changePct(sym: string): number {
    return (this.price[sym] / this.open[sym] - 1) * 100;
  }
  dispose(): void {
    this.disposed = true;
    if (this.retry) clearTimeout(this.retry);
    this.ws?.close();
  }
}

async function fetchJson(url: string): Promise<unknown> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error(`Binance ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

function toCandle(k: (string | number)[]): Candle {
  return { t: Number(k[0]), o: +k[1], h: +k[2], l: +k[3], c: +k[4] };
}
