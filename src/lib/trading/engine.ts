/**
 * Paper-trading engine for the /terminal route.
 * Prices are SIMULATED (random walk). No real market data, no real money.
 */

import { SIM_TIMEFRAMES, aggregateByTime, type Timeframe } from "./timeframes";

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
  /** Base-asset volume traded in the candle. Optional: not every source provides it. */
  v?: number;
}

/** Minimal quote source the Account needs. */
export interface Quotes {
  price: Record<string, number>;
  bid(sym: string): number;
  ask(sym: string): number;
  /** Real order-book levels [price, size], best first. Absent for simulated feeds. */
  depth?(sym: string): BookDepth | null;
  /** Tell the feed our taker fill ate these [price, size] levels, so later sweeps see less liquidity. */
  consume?(sym: string, side: Side, taken: [number, number][]): void;
}

/** Everything the terminal UI needs from a market data source. */
export interface Feed extends Quotes {
  instruments: Instrument[];
  open: Record<string, number>;
  /** Base-resolution candles (the finest timeframe this feed has). */
  candles: Record<string, Candle[]>;
  /** Chart timeframes this feed can serve, finest first, and the one to show initially. */
  timeframes: Timeframe[];
  defaultTimeframe: string;
  /** Candles for a timeframe id, oldest first; empty until loadTimeframe() has run for it. */
  candlesFor(sym: string, timeframeId: string): Candle[];
  /** Make sure candlesFor(sym, id) has data. Resolves immediately if already loaded; rejects on failure. */
  loadTimeframe(sym: string, timeframeId: string): Promise<void>;
  /**
   * Fetch candles older than the oldest one held and prepend them. `added` is how many were new;
   * `done` means there is no more history to fetch (start of the market, or the per-series cap).
   */
  loadOlder(sym: string, timeframeId: string): Promise<{ added: number; done: boolean }>;
  spread(sym: string): number;
  changePct(sym: string): number;
  /** True while this symbol's visible book is still depleted by our own fills. */
  impactActive?(sym: string): boolean;
  tick(): void;
  dispose(): void;
}

export interface BookDepth {
  bids: [number, number][];
  asks: [number, number][];
}

/** How fast liquidity we consumed comes back (market makers refilling the level). */
export const IMPACT_HALF_LIFE_MS = 5000;

/**
 * Remembers liquidity our own taker fills consumed, per symbol/side/price, and subtracts it
 * from fresh book snapshots. The real book refreshes every 100ms and knows nothing about our
 * paper fills, so without this overlay every level would instantly "refill". Consumption
 * decays exponentially. It is keyed by price, so if the market moves to new levels the old
 * consumption simply no longer applies.
 */
export class ImpactBook {
  private used = new Map<string, { qty: number; t: number }>();
  constructor(
    private now: () => number = Date.now,
    private halfLifeMs: number = IMPACT_HALF_LIFE_MS
  ) {}

  private cur(e: { qty: number; t: number }): number {
    return e.qty * Math.pow(0.5, (this.now() - e.t) / this.halfLifeMs);
  }

  /** An entry is "recovered" once 98% of what it consumed is back; then we stop tracking it. */
  private alive(e: { qty: number; t: number }): boolean {
    return this.cur(e) > e.qty * 0.02;
  }

  /** `side` is the taker's side: BUYs consume asks, SELLs consume bids. */
  consume(sym: string, side: Side, taken: [number, number][]): void {
    for (const [p, q] of taken) {
      const key = `${sym}|${side}|${p}`;
      const e = this.used.get(key);
      this.used.set(key, { qty: (e ? this.cur(e) : 0) + q, t: this.now() });
    }
  }

  has(sym: string): boolean {
    for (const [k, e] of this.used) if (k.startsWith(sym + "|") && this.alive(e)) return true;
    return false;
  }

  /** Returns a copy of `book` with consumed size removed; fully consumed levels are dropped. */
  adjust(sym: string, book: BookDepth): BookDepth {
    for (const [k, e] of this.used) if (!this.alive(e)) this.used.delete(k);
    if (this.used.size === 0) return book;
    const net = (levels: [number, number][], side: Side) =>
      levels
        .map(([p, s]): [number, number] => {
          const e = this.used.get(`${sym}|${side}|${p}`);
          return [p, e ? s - this.cur(e) : s];
        })
        .filter(([, s]) => s > 1e-9);
    return { asks: net(book.asks, "BUY"), bids: net(book.bids, "SELL") };
  }
}

let registry: Instrument[] = UNIVERSE;
export function registerInstruments(list: Instrument[]): void {
  registry = list;
}

export const TICKS_PER_CANDLE = 6;
/** Simulated volume for `ticks` ticks of a move `z` standard deviations big (about $2M notional per candle). */
function simVolume(ins: Instrument, z: number, ticks: number): number {
  const perTick = 2_000_000 / ins.start / TICKS_PER_CANDLE;
  return perTick * ticks * (0.5 + z) * (0.6 + 0.8 * Math.random());
}

const HISTORY = 3600; // base candles of simulated history (3s each = 3h), enough for 5m charts

function gauss(): number {
  // Box–Muller
  const u = 1 - Math.random();
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export class Market implements Feed {
  instruments = UNIVERSE;
  timeframes = SIM_TIMEFRAMES;
  defaultTimeframe = "3s";
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
        // volume grows with how far price moved, like real markets
        const move = Math.abs(Math.log(p / o)) / (ins.vol * Math.sqrt(TICKS_PER_CANDLE));
        list.push({ t: now - i * TICKS_PER_CANDLE * 500, o, h, l, c: p, v: simVolume(ins, move, TICKS_PER_CANDLE) });
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
      const prevPx = this.price[ins.sym];
      const p = this.step(ins, prevPx);
      this.price[ins.sym] = p;
      const list = this.candles[ins.sym];
      const last = list[list.length - 1];
      last.v = (last.v ?? 0) + simVolume(ins, Math.abs(Math.log(p / prevPx)) / ins.vol, 1);
      last.c = p;
      last.h = Math.max(last.h, p);
      last.l = Math.min(last.l, p);
      this.ticks[ins.sym]++;
      if (this.ticks[ins.sym] >= TICKS_PER_CANDLE) {
        this.ticks[ins.sym] = 0;
        list.push({ t: Date.now(), o: p, h: p, l: p, c: p, v: 0 });
        if (list.length > HISTORY * 2) list.shift();
      }
    }
  }

  dispose(): void {}

  candlesFor(sym: string, timeframeId: string): Candle[] {
    const base = this.candles[sym] ?? [];
    const tf = this.timeframes.find((t) => t.id === timeframeId);
    if (!tf) return [];
    return tf.ms <= TICKS_PER_CANDLE * 500 ? base : aggregateByTime(base, tf.ms);
  }
  async loadTimeframe(): Promise<void> {} // everything is derived from the base candles already in memory
  async loadOlder(): Promise<{ added: number; done: boolean }> {
    return { added: 0, done: true }; // the simulation only has the history it generated at startup
  }

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

/** Fee rates as a fraction of notional (Binance spot standard tier: 0.1% / 0.1%). */
export const FEE_RATE = { maker: 0.001, taker: 0.001 } as const;
export type Role = keyof typeof FEE_RATE;
export interface FeeRates {
  maker: number;
  taker: number;
}

export interface Fill {
  id: number;
  orderId: number;
  sym: string;
  side: Side;
  qty: number;
  price: number;
  pnl: number; // realized P&L on this fill (0 for opening buys)
  levels: number; // book levels consumed; price is the volume-weighted average
  slip: number; // adverse slippage vs. best bid/ask at execution, in price units
  fee: number; // quote-currency fee charged on this fill
  role: Role; // taker = executed on submission, maker = filled after resting
  ts: number;
}

export interface Sweep {
  qty: number; // quantity that can execute now (<= requested)
  cost: number; // total notional of that quantity
  levels: number;
  avg: number;
  best: number; // best price on the contra side
  taken: [number, number][]; // [price, size] actually consumed at each level
}

/**
 * Walk the contra side of the book, level by level, until `qty` is filled or
 * the limit price (if any) stops us. Without depth data (simulated feed, or
 * before the first snapshot) top-of-book is treated as unlimited size.
 */
export function sweep(m: Quotes, sym: string, side: Side, qty: number, limit?: number): Sweep {
  const book = m.depth?.(sym);
  const best = side === "BUY" ? m.ask(sym) : m.bid(sym);
  // No depth data at all -> top-of-book with unlimited size. Depth present but empty (fully
  // consumed by our own fills) means there is genuinely nothing to hit right now.
  const levels: [number, number][] = book ? (side === "BUY" ? book.asks : book.bids) : [[best, Infinity]];
  let left = qty;
  let cost = 0;
  let used = 0;
  let n = 0;
  const taken: [number, number][] = [];
  for (const [px, size] of levels) {
    if (limit !== undefined && (side === "BUY" ? px > limit : px < limit)) break;
    const take = Math.min(left, size);
    if (take <= 0) break;
    cost += take * px;
    used += take;
    taken.push([px, take]);
    left -= take;
    n++;
    if (left <= 1e-12) break;
  }
  return { qty: used, cost, levels: n, avg: used > 0 ? cost / used : best, best: levels[0]?.[0] ?? best, taken };
}

export interface Position {
  qty: number;
  avg: number;
}

export const START_CASH = 100_000;

export interface AccountSnapshot {
  v: 1;
  cash: number;
  positions: Record<string, Position>;
  orders: Order[];
  fills: Fill[];
  realized: number;
  fees: number;
  nextOrder: number;
  nextFill: number;
}

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isSide = (x: unknown): x is Side => x === "BUY" || x === "SELL";

export class Account {
  cash = START_CASH;
  positions: Record<string, Position> = {};
  orders: Order[] = [];
  fills: Fill[] = [];
  realized = 0; // net of fees
  fees = 0; // total fees paid
  /** Rates charged on new fills. Past fills keep the fee they were charged. Not part of the saved snapshot. */
  rates: FeeRates = { ...FEE_RATE };
  private nextOrder = 1;
  private nextFill = 1;

  snapshot(): AccountSnapshot {
    return {
      v: 1,
      cash: this.cash,
      positions: this.positions,
      orders: this.orders,
      fills: this.fills,
      realized: this.realized,
      fees: this.fees,
      nextOrder: this.nextOrder,
      nextFill: this.nextFill,
    };
  }

  /** Cheap change detector so callers only write storage when something actually changed. */
  signature(): string {
    return [this.nextOrder, this.nextFill, this.orders.length, this.cash, this.realized, this.fees].join("|");
  }

  /**
   * Rebuild an account from untrusted stored JSON. Returns null if the data is malformed.
   * Positions/orders for symbols the current feed doesn't know are dropped and counted.
   */
  static restore(raw: unknown, validSyms: Set<string>): { account: Account; dropped: number } | null {
    const r = raw as Partial<AccountSnapshot> | null;
    if (!r || typeof r !== "object" || r.v !== 1) return null;
    if (![r.cash, r.realized, r.fees, r.nextOrder, r.nextFill].every(isNum)) return null;
    if (!r.positions || typeof r.positions !== "object" || !Array.isArray(r.orders) || !Array.isArray(r.fills)) return null;

    const a = new Account();
    let dropped = 0;
    a.cash = r.cash!;
    a.realized = r.realized!;
    a.fees = r.fees!;
    a.nextOrder = Math.max(1, Math.floor(r.nextOrder!));
    a.nextFill = Math.max(1, Math.floor(r.nextFill!));

    for (const [sym, p] of Object.entries(r.positions)) {
      if (!p || !isNum(p.qty) || !isNum(p.avg) || p.qty <= 0) return null;
      if (validSyms.has(sym)) a.positions[sym] = { qty: p.qty, avg: p.avg };
      else dropped++;
    }
    for (const o of r.orders as Order[]) {
      if (!o || !isNum(o.id) || !isNum(o.qty) || o.qty <= 0 || !isSide(o.side) || o.type !== "LMT") return null;
      if (!isNum(o.limit) || o.limit <= 0 || typeof o.sym !== "string" || !isNum(o.ts)) return null;
      if (validSyms.has(o.sym)) a.orders.push({ id: o.id, sym: o.sym, side: o.side, type: "LMT", qty: o.qty, limit: o.limit, ts: o.ts });
      else dropped++;
    }
    for (const f of (r.fills as Fill[]).slice(0, 200)) {
      const ok =
        f && [f.id, f.orderId, f.qty, f.price, f.pnl, f.levels, f.slip, f.fee, f.ts].every(isNum) &&
        f.qty > 0 && f.price > 0 && f.fee >= 0 && f.levels >= 1 &&
        isSide(f.side) && typeof f.sym === "string" && (f.role === "maker" || f.role === "taker");
      if (!ok) return null;
      // whitelist fields: never carry unknown properties from an external file into the account
      a.fills.push({
        id: f.id, orderId: f.orderId, sym: f.sym, side: f.side, qty: f.qty, price: f.price, pnl: f.pnl,
        levels: f.levels, slip: f.slip, fee: f.fee, role: f.role, ts: f.ts,
      });
    }
    // Ids must be unique and the counters must stay ahead of every id in the file, otherwise a
    // hand-edited backup could make the next order or fill collide with an existing one.
    if (new Set(a.orders.map((o) => o.id)).size !== a.orders.length) return null;
    if (new Set(a.fills.map((f) => f.id)).size !== a.fills.length) return null;
    a.nextOrder = Math.max(a.nextOrder, ...a.orders.map((o) => o.id + 1), ...a.fills.map((f) => f.orderId + 1));
    a.nextFill = Math.max(a.nextFill, ...a.fills.map((f) => f.id + 1));
    return { account: a, dropped };
  }

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
      const reserved = this.orders
        .filter((x) => x.side === "BUY")
        .reduce((s, x) => s + x.qty * (x.limit ?? m.ask(x.sym)) * (1 + this.rates.taker), 0);
      const notional = o.type === "LMT" ? o.qty * o.limit! : sweep(m, o.sym, "BUY", o.qty).cost;
      const need = notional * (1 + this.rates.taker);
      if (need > this.cash - reserved + 1e-6) return "Insufficient buying power";
    }
    if (o.type === "MKT") {
      // Market orders are all-or-none against the visible book: no partial fills, no guessing
      // at liquidity we can't see.
      const sw = sweep(m, o.sym, o.side, o.qty);
      if (sw.qty < o.qty - 1e-9)
        return `Not enough visible liquidity: only ${sw.qty} ${o.sym} within the top ${sw.levels} book levels. Reduce size or use a limit order.`;
    }
    const order: Order = { ...o, id: this.nextOrder++, ts: Date.now() };
    // Whatever executes right now crosses the spread, so it is a taker fill.
    const done = this.execute(m, order, "taker");
    if (order.type === "LMT" && done < order.qty - 1e-9) {
      order.qty -= done;
      this.orders.push(order);
    }
    return null;
  }

  cancel(id: number | "all"): number {
    const before = this.orders.length;
    this.orders = id === "all" ? [] : this.orders.filter((o) => o.id !== id);
    return before - this.orders.length;
  }

  /** Execute any resting limit orders that are now marketable (partial fills allowed). */
  match(m: Quotes): void {
    for (const o of [...this.orders]) {
      const filled = this.execute(m, o, "maker"); // these orders were resting, so they provided liquidity
      if (filled >= o.qty - 1e-9) this.orders = this.orders.filter((x) => x.id !== o.id);
      else if (filled > 0) o.qty -= filled;
    }
  }

  /** Sweep the book for `o`, record one VWAP fill, and return the quantity executed. */
  private execute(m: Quotes, o: Order, role: Role): number {
    const sw = sweep(m, o.sym, o.side, o.qty, o.type === "LMT" ? o.limit : undefined);
    if (sw.qty <= 0) return 0;
    this.fill(o, sw.avg, sw.qty, sw.levels, Math.abs(sw.avg - sw.best), sw.cost * this.rates[role], role);
    // Only a taker fill eats visible liquidity; a maker fill means someone else hit our resting order.
    if (role === "taker") m.consume?.(o.sym, o.side, sw.taken);
    return sw.qty;
  }

  private fill(o: Order, price: number, qty: number, levels: number, slip: number, fee: number, role: Role): void {
    let pnl = 0;
    const pos = this.positions[o.sym] ?? { qty: 0, avg: 0 };
    if (o.side === "BUY") {
      const total = pos.qty + qty;
      pos.avg = (pos.avg * pos.qty + price * qty + fee) / total; // buy fee is capitalised into cost basis
      pos.qty = total;
      this.cash -= price * qty + fee;
    } else {
      pnl = (price - pos.avg) * qty - fee; // net of the sell-side fee
      pos.qty -= qty;
      this.cash += price * qty - fee;
      this.realized += pnl;
    }
    this.fees += fee;
    if (pos.qty < 1e-9) delete this.positions[o.sym];
    else this.positions[o.sym] = pos;
    this.fills.unshift({
      id: this.nextFill++,
      orderId: o.id,
      sym: o.sym,
      side: o.side,
      qty,
      price,
      pnl,
      levels,
      slip,
      fee,
      role,
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
