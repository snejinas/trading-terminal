// Estimated liquidation heatmap. Binance publishes no forward-looking liquidation levels, so this is a MODEL:
//  1. every candle opens some amount of new leveraged positions (from open-interest growth, or traded volume),
//  2. spread over leverage tiers and both sides at the candle's typical price,
//  3. each position has a liquidation price (long below its entry, short above);
//  4. it stays on the map until price trades through that level (then it would have been liquidated).
import type { Candle } from "./engine";

export interface LiqTier {
  lev: number;
  share: number; // of the inflow; shares sum to 1
}
export const LIQ_TIERS: LiqTier[] = [
  { lev: 5, share: 0.1 },
  { lev: 10, share: 0.3 },
  { lev: 25, share: 0.3 },
  { lev: 50, share: 0.2 },
  { lev: 100, share: 0.1 },
];
/** Maintenance margin rate (a typical figure for large perpetual contracts). */
export const MAINT_MARGIN = 0.005;
export const LONG_SHARE = 0.5; // the split between longs and shorts is unknown: assume even

export type Side = "long" | "short";

/** Price at which a position opened at `entry` with leverage `lev` is liquidated (isolated margin, linear contract). */
export function liqPrice(entry: number, lev: number, side: Side, mm = MAINT_MARGIN): number {
  return side === "long" ? entry * (1 - 1 / lev + mm) : entry * (1 + 1 / lev - mm);
}

export interface OiPoint {
  t: number; // snapshot time (ms)
  v: number; // open interest, USD notional
}

/** Parses Binance's openInterestHist rows; keeps finite points in time order. */
export function parseOiRows(rows: unknown): OiPoint[] {
  if (!Array.isArray(rows)) return [];
  const out: OiPoint[] = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const t = Number(o.timestamp);
    const v = Number(o.sumOpenInterestValue);
    if (Number.isFinite(t) && t > 0 && Number.isFinite(v) && v >= 0) out.push({ t, v });
  }
  out.sort((a, b) => a.t - b.t);
  return out.filter((p, i) => i === 0 || p.t !== out[i - 1].t);
}

const typical = (c: Candle) => (c.h + c.l + c.c) / 3;

/** New-position inflow per candle (USD) from traded volume: the fallback when there is no open-interest data. */
export function inflowFromVolume(candles: Candle[]): number[] {
  return candles.map((c) => {
    const x = (c.v ?? 0) * typical(c);
    return Number.isFinite(x) && x > 0 ? x : 0;
  });
}

/**
 * New-position inflow per candle (USD) from open-interest snapshots: growth between two snapshots is attributed
 * evenly over the time between them, so a candle receives the share of each growth interval it overlaps.
 * Decreases (positions closing) add nothing. Candles outside the snapshot range get 0.
 */
export function inflowFromOi(candles: Candle[], oi: OiPoint[], tfMs: number): number[] {
  const out = new Array(candles.length).fill(0);
  if (oi.length < 2 || !(tfMs > 0)) return out;
  let c0 = 0; // first candle that may still overlap the current interval
  for (let k = 1; k < oi.length; k++) {
    const t0 = oi[k - 1].t;
    const t1 = oi[k].t;
    const d = oi[k].v - oi[k - 1].v;
    if (!(d > 0) || !(t1 > t0)) continue;
    while (c0 < candles.length && candles[c0].t + tfMs <= t0) c0++;
    for (let i = c0; i < candles.length && candles[i].t < t1; i++) {
      const overlap = Math.min(t1, candles[i].t + tfMs) - Math.max(t0, candles[i].t);
      if (overlap > 0) out[i] += (d * overlap) / (t1 - t0);
    }
  }
  return out;
}

export interface Segment {
  from: number; // candle index where the position opened
  to: number; // first candle that traded through the level (liquidated); candles.length if still alive
  price: number; // liquidation price
  amount: number; // USD notional
  side: Side;
  lev: number;
}

/** Sparse tables so "first candle at/after i whose low <= L" (or high >= L) is O(log n). */
function sparse(values: ArrayLike<number>, pick: (a: number, b: number) => number): Float64Array[] {
  const n = values.length;
  const levels: Float64Array[] = [Float64Array.from(values as ArrayLike<number>)];
  for (let k = 1; 1 << k <= n; k++) {
    const prev = levels[k - 1];
    const cur = new Float64Array(n - (1 << k) + 1);
    for (let i = 0; i < cur.length; i++) cur[i] = pick(prev[i], prev[i + (1 << (k - 1))]);
    levels.push(cur);
  }
  return levels;
}
/** First index >= from where the block minimum is <= L (or n). `above` flips it to "maximum >= L". */
function firstHit(table: Float64Array[], n: number, from: number, L: number, above: boolean): number {
  let pos = from;
  for (let k = table.length - 1; k >= 0; k--) {
    if (pos + (1 << k) <= n) {
      const blk = table[k][pos];
      if (above ? blk < L : blk > L) pos += 1 << k;
    }
  }
  return pos;
}

export function buildSegments(candles: Candle[], inflow: number[], tiers: LiqTier[] = LIQ_TIERS, mm = MAINT_MARGIN): Segment[] {
  const n = candles.length;
  const out: Segment[] = [];
  if (n === 0) return out;
  const lows = sparse(candles.map((c) => c.l), Math.min);
  const highs = sparse(candles.map((c) => c.h), Math.max);
  for (let i = 0; i < n; i++) {
    const w = inflow[i];
    if (!(w > 0)) continue;
    const entry = typical(candles[i]);
    if (!(entry > 0)) continue;
    for (const tier of tiers) {
      for (const side of ["long", "short"] as const) {
        const price = liqPrice(entry, tier.lev, side, mm);
        if (!(price > 0) || !Number.isFinite(price)) continue;
        const to = side === "long" ? firstHit(lows, n, i + 1, price, false) : firstHit(highs, n, i + 1, price, true);
        out.push({ from: i, to, price, amount: w * tier.share * (side === "long" ? LONG_SHARE : 1 - LONG_SHARE), side, lev: tier.lev });
      }
    }
  }
  return out;
}

export interface HeatGrid {
  rows: number;
  cols: number;
  group: number; // candles per column
  cells: Float32Array; // rows x cols, row 0 at the top (highest price); USD of estimated liquidations alive there
  max: number;
}

/**
 * Rasterises segments for the candles [first, last] into `rows` price rows spanning [lo, hi] (row 0 = hi).
 * At most `maxCols` columns: when more candles are visible several share a column.
 */
export function buildGrid(segments: Segment[], first: number, last: number, lo: number, hi: number, rows: number, maxCols: number): HeatGrid {
  const nVis = Math.max(0, last - first + 1);
  const group = Math.max(1, Math.ceil(nVis / Math.max(1, maxCols)));
  const cols = nVis === 0 ? 0 : Math.ceil(nVis / group);
  const cells = new Float32Array(rows * cols);
  if (cols === 0 || rows <= 0 || !(hi > lo)) return { rows, cols, group, cells, max: 0 };
  const stride = cols + 1;
  const diff = new Float64Array(rows * stride);
  for (const s of segments) {
    if (s.to <= first || s.from > last) continue;
    if (s.price > hi || s.price < lo) continue;
    const r = Math.min(rows - 1, Math.floor(((hi - s.price) / (hi - lo)) * rows));
    const c0 = Math.floor((Math.max(s.from, first) - first) / group);
    const c1 = s.to > last ? cols : Math.floor((s.to - 1 - first) / group) + 1;
    if (c1 <= c0) continue;
    diff[r * stride + c0] += s.amount;
    diff[r * stride + c1] -= s.amount;
  }
  let max = 0;
  for (let r = 0; r < rows; r++) {
    let run = 0;
    for (let c = 0; c < cols; c++) {
      run += diff[r * stride + c];
      const v = run > 1e-9 ? run : 0;
      cells[r * cols + c] = v;
      if (v > max) max = v;
    }
  }
  return { rows, cols, group, cells, max };
}

/** Heat colour for an intensity in [0, 1]: cold purple through teal to yellow. */
const STOPS: [number, number, number][] = [
  [38, 20, 80],
  [60, 60, 170],
  [30, 150, 190],
  [60, 210, 140],
  [250, 230, 60],
];
export function heatColor(t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0)) * (STOPS.length - 1);
  const i = Math.min(STOPS.length - 2, Math.floor(x));
  const f = x - i;
  return [0, 1, 2].map((k) => Math.round(STOPS[i][k] + (STOPS[i + 1][k] - STOPS[i][k]) * f)) as [number, number, number];
}

/** Which input drives the estimate. */
export type LiqMode = "oi" | "volume";

export function inflowFor(candles: Candle[], oi: OiPoint[] | null, tfMs: number): { mode: LiqMode; inflow: number[] } {
  if (oi && oi.length >= 2) return { mode: "oi", inflow: inflowFromOi(candles, oi, tfMs) };
  return { mode: "volume", inflow: inflowFromVolume(candles) };
}

/** Binance's open-interest history periods (5m is the finest); the closest one for a chart timeframe. */
export const OI_PERIODS: Record<string, string> = { "1m": "5m", "5m": "5m", "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d" };
export const oiPeriod = (timeframeId: string): string => OI_PERIODS[timeframeId] ?? "1h";

const KEY = "lifeinception.terminal.chart.liq.v1";
export function loadLiqPref(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}
export function saveLiqPref(on: boolean): void {
  try {
    window.localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* storage may be blocked; the setting just won't be remembered */
  }
}
