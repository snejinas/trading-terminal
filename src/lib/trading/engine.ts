/**
 * Paper-trading engine for the /terminal route.
 * Prices are SIMULATED (random walk). No real market data, no real money.
 */

export interface Instrument {
  sym: string;
  name: string;
  start: number; // starting price
  vol: number; // per-tick volatility (fraction)
  dp: number; // display decimals
}

export const UNIVERSE: Instrument[] = [
  { sym: "AAPL", name: "Apple Inc.", start: 228.4, vol: 0.0007, dp: 2 },
  { sym: "MSFT", name: "Microsoft Corp.", start: 431.2, vol: 0.0006, dp: 2 },
  { sym: "NVDA", name: "NVIDIA Corp.", start: 142.7, vol: 0.0012, dp: 2 },
  { sym: "TSLA", name: "Tesla Inc.", start: 251.9, vol: 0.0016, dp: 2 },
  { sym: "SPY", name: "S&P 500 ETF", start: 584.3, vol: 0.0004, dp: 2 },
  { sym: "BTC", name: "Bitcoin", start: 68250, vol: 0.0014, dp: 2 },
  { sym: "ETH", name: "Ethereum", start: 2480, vol: 0.0018, dp: 2 },
  { sym: "EURUSD", name: "Euro / US Dollar", start: 1.0842, vol: 0.00025, dp: 5 },
];

export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

/** Minimal quote source the Account needs. */
export interface Quotes {
  price: Record<string, number>;
  bid(sym: string): number;
  ask(sym: string): number;
}

/** Everything the terminal UI needs from a market data source. */
export interface Feed extends Quotes {
  instruments: Instrument[];
  open: Record<string, number>;
  candles: Record<string, Candle[]>;
  spread(sym: string): number;
  changePct(sym: string): number;
  tick(): void;
  dispose(): void;
}

let registry: Instrument[] = UNIVERSE;
export function registerInstruments(list: Instrument[]): void {
  registry = list;
}

export const TICKS_PER_CANDLE = 6;
const HISTORY = 160;

function gauss(): number {
  // Box–Muller
  const u = 1 - Math.random();
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export class Market implements Feed {
  instruments = UNIVERSE;
  price: Record<string, number> = {};
  open: Record<string, number> = {};
  candles: Record<string, Candle[]> = {};
  private ticks: Record<string, number> = {};

  constructor() {
    for (const ins of UNIVERSE) {
      // Generate history backwards-ish: walk forward from a perturbed start.
      let p = ins.start * (1 + gauss() * 0.01);
      const list: Candle[] = [];
      const now = Date.now();
      for (let i = HISTORY; i > 0; i--) {
        const o = p;
        let h = o;
        let l = o;
        for (let k = 0; k < TICKS_PER_CANDLE; k++) {
          p = this.step(ins, p);
          h = Math.max(h, p);
          l = Math.min(l, p);
        }
        list.push({ t: now - i * TICKS_PER_CANDLE * 500, o, h, l, c: p });
      }
      this.candles[ins.sym] = list;
      this.price[ins.sym] = p;
      this.open[ins.sym] = list[0].o;
      this.ticks[ins.sym] = 0;
    }
  }

  private step(ins: Instrument, p: number): number {
    // slight mean reversion to start price keeps the sim from drifting to zero/infinity
    const revert = (ins.start - p) / ins.start;
    return Math.max(p * Math.exp(ins.vol * gauss() + revert * 0.0008), ins.start * 0.05);
  }

  tick(): void {
    for (const ins of UNIVERSE) {
      const p = this.step(ins, this.price[ins.sym]);
      this.price[ins.sym] = p;
      const list = this.candles[ins.sym];
      const last = list[list.length - 1];
      last.c = p;
      last.h = Math.max(last.h, p);
      last.l = Math.min(last.l, p);
      this.ticks[ins.sym]++;
      if (this.ticks[ins.sym] >= TICKS_PER_CANDLE) {
        this.ticks[ins.sym] = 0;
        list.push({ t: Date.now(), o: p, h: p, l: p, c: p });
        if (list.length > HISTORY * 2) list.shift();
      }
    }
  }

  dispose(): void {}

  spread(sym: string): number {
    return this.price[sym] * 0.0002;
  }
  bid(sym: string): number {
    return this.price[sym] - this.spread(sym) / 2;
  }
  ask(sym: string): number {
    return this.price[sym] + this.spread(sym) / 2;
  }
  changePct(sym: string): number {
    return (this.price[sym] / this.open[sym] - 1) * 100;
  }
}

// ─── Account ────────────────────────────────────────────────────────────────

export type Side = "BUY" | "SELL";
export type OrderType = "MKT" | "LMT";

export interface Order {
  id: number;
  sym: string;
  side: Side;
  type: OrderType;
  qty: number;
  limit?: number;
  ts: number;
}

export interface Fill {
  id: number;
  orderId: number;
  sym: string;
  side: Side;
  qty: number;
  price: number;
  pnl: number; // realized P&L on this fill (0 for opening buys)
  ts: number;
}

export interface Position {
  qty: number;
  avg: number;
}

export const START_CASH = 100_000;

export class Account {
  cash = START_CASH;
  positions: Record<string, Position> = {};
  orders: Order[] = [];
  fills: Fill[] = [];
  realized = 0;
  private nextOrder = 1;
  private nextFill = 1;

  equity(m: Quotes): number {
    let e = this.cash;
    for (const [sym, p] of Object.entries(this.positions)) e += p.qty * m.price[sym];
    return e;
  }

  unrealized(m: Quotes): number {
    let u = 0;
    for (const [sym, p] of Object.entries(this.positions)) u += p.qty * (m.price[sym] - p.avg);
    return u;
  }

  /** Returns an error string, or null on success. */
  submit(m: Quotes, o: Omit<Order, "id" | "ts">): string | null {
    if (!m.price[o.sym]) return `Unknown symbol ${o.sym}`;
    if (!(o.qty > 0) || !isFinite(o.qty)) return "Quantity must be greater than 0";
    if (o.type === "LMT" && !(o.limit && o.limit > 0)) return "Limit orders need a positive price";
    if (o.side === "SELL") {
      const held = this.positions[o.sym]?.qty ?? 0;
      const reserved = this.orders
        .filter((x) => x.sym === o.sym && x.side === "SELL")
        .reduce((s, x) => s + x.qty, 0);
      if (o.qty > held - reserved + 1e-9) return `Insufficient position (shorting is disabled): ${held - reserved} available`;
    } else {
      const px = o.type === "LMT" ? o.limit! : m.ask(o.sym);
      const reserved = this.orders
        .filter((x) => x.side === "BUY")
        .reduce((s, x) => s + x.qty * (x.limit ?? m.ask(x.sym)), 0);
      if (o.qty * px > this.cash - reserved + 1e-6) return "Insufficient buying power";
    }
    const order: Order = { ...o, id: this.nextOrder++, ts: Date.now() };
    if (order.type === "MKT") {
      this.fill(order, order.side === "BUY" ? m.ask(order.sym) : m.bid(order.sym));
    } else {
      this.orders.push(order);
      this.match(m);
    }
    return null;
  }

  cancel(id: number | "all"): number {
    const before = this.orders.length;
    this.orders = id === "all" ? [] : this.orders.filter((o) => o.id !== id);
    return before - this.orders.length;
  }

  /** Fill any resting limit orders that are now marketable. */
  match(m: Quotes): void {
    for (const o of [...this.orders]) {
      const px = o.side === "BUY" ? m.ask(o.sym) : m.bid(o.sym);
      const hit = o.side === "BUY" ? px <= o.limit! : px >= o.limit!;
      if (hit) {
        this.orders = this.orders.filter((x) => x.id !== o.id);
        this.fill(o, o.limit!);
      }
    }
  }

  private fill(o: Order, price: number): void {
    let pnl = 0;
    const pos = this.positions[o.sym] ?? { qty: 0, avg: 0 };
    if (o.side === "BUY") {
      const total = pos.qty + o.qty;
      pos.avg = (pos.avg * pos.qty + price * o.qty) / total;
      pos.qty = total;
      this.cash -= price * o.qty;
    } else {
      pnl = (price - pos.avg) * o.qty;
      pos.qty -= o.qty;
      this.cash += price * o.qty;
      this.realized += pnl;
    }
    if (pos.qty < 1e-9) delete this.positions[o.sym];
    else this.positions[o.sym] = pos;
    this.fills.unshift({
      id: this.nextFill++,
      orderId: o.id,
      sym: o.sym,
      side: o.side,
      qty: o.qty,
      price,
      pnl,
      ts: Date.now(),
    });
    if (this.fills.length > 200) this.fills.pop();
  }
}

// ─── Formatting ─────────────────────────────────────────────────────────────

export function fmt(n: number, dp = 2): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
export function fmtQty(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 6 });
}
export function dpFor(sym: string): number {
  return registry.find((i) => i.sym === sym)?.dp ?? 2;
}
