// Order flow footprint: traded volume split by aggressor (buyers lifting the ask, sellers hitting the bid) at each price level.
// Trades are stored compactly (per minute, per price level) and regrouped per candle and per display row when drawing.

/** A trade as Binance reports it (aggTrade). `m` = the buyer was the maker, i.e. the SELLER was the aggressor. */
export interface Trade {
  id: number;
  t: number; // ms
  p: number;
  q: number;
  m: boolean;
}

export interface FlowCell {
  b: number; // volume bought at the ask (buyer aggressor)
  s: number; // volume sold at the bid (seller aggressor)
}

export interface FlowStore {
  baseTick: number; // price resolution of the stored levels
  minutes: Map<number, Map<number, FlowCell>>; // minute start (ms) -> level key (round(price / baseTick)) -> volumes
  minId: number;
  maxId: number;
  trades: number;
  firstT: number; // oldest and newest trade time held (Infinity / -Infinity when empty)
  lastT: number;
}

const MIN = 60_000;
/** Drawing limits: the footprint is only drawn for this many candles or fewer, in rows at least this tall, with numbers once a candle is this wide. */
export const FP_MAX_CANDLES = 120;
export const FP_MIN_ROW_PX = 11;
export const FP_TEXT_MIN_SLOT = 52;
export const FLOW_RETENTION_MS = 4 * 60 * MIN; // history kept: the last four hours of trading

export const createFlowStore = (baseTick: number): FlowStore => ({
  baseTick,
  minutes: new Map(),
  minId: Infinity,
  maxId: -Infinity,
  trades: 0,
  firstT: Infinity,
  lastT: -Infinity,
});

/**
 * Adds a trade. `live` trades must be newer than anything held (id above the maximum); `history` trades older (id below
 * the minimum), which keeps a backfill and the live stream from counting the same trade twice. Returns whether it was added.
 */
export function addTrade(store: FlowStore, tr: Trade, source: "live" | "history"): boolean {
  if (!Number.isFinite(tr.id) || !Number.isFinite(tr.t) || !Number.isFinite(tr.p) || !(tr.q > 0) || !Number.isFinite(tr.q) || !(tr.p > 0)) return false;
  if (store.trades > 0) {
    if (source === "live" ? tr.id <= store.maxId : tr.id >= store.minId) return false;
  }
  if (tr.t < Math.max(store.lastT, tr.t) - FLOW_RETENTION_MS) return false; // older than we keep
  const minute = Math.floor(tr.t / MIN) * MIN;
  let level = store.minutes.get(minute);
  if (!level) store.minutes.set(minute, (level = new Map()));
  const key = Math.round(tr.p / store.baseTick);
  const cell = level.get(key) ?? { b: 0, s: 0 };
  if (tr.m) cell.s += tr.q;
  else cell.b += tr.q;
  level.set(key, cell);
  store.trades++;
  store.minId = Math.min(store.minId, tr.id);
  store.maxId = Math.max(store.maxId, tr.id);
  store.firstT = Math.min(store.firstT, tr.t);
  store.lastT = Math.max(store.lastT, tr.t);
  if (source === "live") pruneFlow(store);
  return true;
}

/** Drops minutes older than the retention window (relative to the newest trade). */
export function pruneFlow(store: FlowStore): void {
  const cutoff = store.lastT - FLOW_RETENTION_MS;
  for (const minute of store.minutes.keys()) if (minute + MIN <= cutoff) store.minutes.delete(minute);
}

/** A "nice" price step (1, 2, 2.5 or 5 x a power of ten) of at least `raw`. */
export function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const base = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / base;
  for (const m of [1, 2, 2.5, 5, 10]) if (f <= m + 1e-9) return m * base;
  return 10 * base;
}

export interface FootprintLevel {
  k: number; // display row index: the row spans [k * step, (k + 1) * step)
  price: number; // lower edge of the row
  b: number;
  s: number;
}
export interface Footprint {
  t: number;
  levels: FootprintLevel[]; // highest price first
  buy: number;
  sell: number;
  delta: number; // buy - sell
  pocK: number; // the row with the most volume (ties go to the higher price)
}

/** Regroups the trades of one candle [t, t + tfMs) into rows of `step`. Null when the store has no trade in that period. */
export function footprintOf(store: FlowStore, t: number, tfMs: number, step: number): Footprint | null {
  const rows = new Map<number, FlowCell>();
  const first = Math.floor(t / MIN) * MIN;
  for (let m = first; m < t + tfMs; m += MIN) {
    const lv = store.minutes.get(m);
    if (!lv) continue;
    for (const [key, c] of lv) {
      const k = Math.floor((key * store.baseTick) / step + 1e-9);
      const r = rows.get(k);
      if (r) {
        r.b += c.b;
        r.s += c.s;
      } else rows.set(k, { b: c.b, s: c.s });
    }
  }
  if (rows.size === 0) return null;
  const levels: FootprintLevel[] = [...rows.entries()].sort((a, b) => b[0] - a[0]).map(([k, c]) => ({ k, price: k * step, b: c.b, s: c.s }));
  let buy = 0;
  let sell = 0;
  let poc = levels[0];
  for (const l of levels) {
    buy += l.b;
    sell += l.s;
    if (l.b + l.s > poc.b + poc.s) poc = l;
  }
  return { t, levels, buy, sell, delta: buy - sell, pocK: poc.k };
}

/**
 * Diagonal imbalances: buyers dominate at a row when the volume bought there is at least `ratio` times the volume sold one
 * row lower (they lifted offers that sellers had not been hitting); sellers dominate when the volume sold is at least
 * `ratio` times the volume bought one row higher. Returns, for every level, [buyImbalance, sellImbalance].
 */
export function imbalances(levels: FootprintLevel[], ratio = 3): [boolean, boolean][] {
  return levels.map((l, i) => {
    const lower = levels[i + 1]; // next row down (lower price)
    const higher = levels[i - 1]; // next row up
    const lowerSold = lower && lower.k === l.k - 1 ? lower.s : 0;
    const higherBought = higher && higher.k === l.k + 1 ? higher.b : 0;
    return [l.b > 0 && l.b >= ratio * lowerSold, l.s > 0 && l.s >= ratio * higherBought];
  });
}

/** Compact volume for a cell: blank for zero, no more than four characters for typical sizes. */
export function fmtFlow(v: number): string {
  if (!(v > 0) || !Number.isFinite(v)) return "·";
  if (v >= 10000) return `${Math.round(v / 1000)}K`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}K`;
  if (v >= 100) return String(Math.round(v));
  if (v >= 10) return v.toFixed(1);
  if (v >= 0.01) return v.toFixed(2);
  return v.toFixed(3).replace(/^0/, "");
}

/** How far a candle's footprint reaches into the stored history. */
export const flowCoverage = (store: FlowStore | null): { trades: number; firstT: number | null; lastT: number | null } =>
  store && store.trades > 0 ? { trades: store.trades, firstT: store.firstT, lastT: store.lastT } : { trades: 0, firstT: null, lastT: null };

const KEY = "lifeinception.terminal.chart.footprint.v1";
export function loadFootprintPref(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}
export function saveFootprintPref(on: boolean): void {
  try {
    window.localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* storage may be blocked; the setting just won't be remembered */
  }
}
