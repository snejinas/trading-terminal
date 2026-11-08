/**
 * Binance PUBLIC market data (no API key). Orders are still paper-traded locally.
 * Uses the market-data-only hosts, which work without credentials and are not
 * geo-restricted the way api.binance.com can be.
 */
import { registerInstruments, type BookDepth, type Candle, type Feed, type Instrument } from "./engine";

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
  private books: Record<string, BookDepth> = {};
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
    ws.onopen = () => (this.connected = true);
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
      } else if (d.b !== undefined && d.a !== undefined && d.s) {
        // bookTicker: best bid / ask
        this.bids[d.s] = parseFloat(d.b);
        this.asks[d.s] = parseFloat(d.a);
      }
    };
  }

  tick(): void {}
  depth(sym: string): BookDepth | null {
    return this.books[sym] ?? null;
  }
  bid(sym: string): number {
    return this.bids[sym] ?? this.price[sym];
  }
  ask(sym: string): number {
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
