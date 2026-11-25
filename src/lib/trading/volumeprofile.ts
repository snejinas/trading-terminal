// Visible-range volume profile: traded volume by price level, the point of control and the value area.
import type { Candle } from "./engine";

export interface VpConfig {
  enabled: boolean;
  rows: number; // price levels (bins) across the visible price range
  va: number; // value area, percent of the total volume
}
export const VP_MIN_ROWS = 10;
export const VP_MAX_ROWS = 200;
export const VP_MIN_VA = 50;
export const VP_MAX_VA = 95;
export const DEFAULT_VP: VpConfig = { enabled: false, rows: 48, va: 70 };
export const VP_MAX_WIDTH = 0.28; // of the plot width, for the busiest level

export interface Profile {
  rows: number;
  lo: number;
  hi: number;
  bins: Float64Array; // volume per level; bin 0 is the top (highest prices), like the chart's rows
  total: number;
}

/**
 * Spreads every candle's volume evenly over its high-low range and adds it to the price levels it touches.
 * Levels are `rows` equal slices of [lo, hi]. A candle with no range puts all its volume in one level.
 * Volume of a candle that reaches outside [lo, hi] is lost in proportion (the chart's range normally holds them all).
 */
export function volumeProfile(candles: ArrayLike<Candle>, lo: number, hi: number, rows: number): Profile {
  const bins = new Float64Array(Math.max(0, rows));
  if (!(hi > lo) || !(rows >= 1) || !Number.isInteger(rows)) return { rows: bins.length, lo, hi, bins, total: 0 };
  const bw = (hi - lo) / rows;
  const rowOf = (p: number) => Math.min(rows - 1, Math.max(0, Math.floor((hi - p) / bw)));
  let total = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const v = c.v;
    if (v === undefined || !(v > 0) || !Number.isFinite(v) || !Number.isFinite(c.h) || !Number.isFinite(c.l)) continue;
    const top = Math.max(c.h, c.l);
    const bot = Math.min(c.h, c.l);
    if (top < lo || bot > hi) continue; // entirely outside the range
    if (top === bot) {
      bins[rowOf(top)] += v;
      total += v;
      continue;
    }
    const range = top - bot;
    const r0 = rowOf(Math.min(top, hi));
    const r1 = rowOf(Math.max(bot, lo));
    for (let r = r0; r <= r1; r++) {
      const binTop = hi - r * bw;
      const overlap = Math.min(top, binTop) - Math.max(bot, binTop - bw);
      if (overlap > 0) {
        const part = (v * overlap) / range;
        bins[r] += part;
        total += part;
      }
    }
  }
  return { rows, lo, hi, bins, total };
}

export interface ProfileStats {
  pocRow: number;
  pocPrice: number; // centre of the busiest level
  pocVolume: number;
  vahRow: number; // top row of the value area (highest prices)
  valRow: number; // bottom row of the value area
  vah: number; // upper edge of the value area
  val: number; // lower edge of the value area
  vaVolume: number;
}

/**
 * The point of control (the busiest level; ties go to the higher price) and the value area: the smallest run of
 * levels around it, grown one level at a time towards whichever neighbour is busier (ties go up), that holds at
 * least `vaFraction` of the total volume. Null when there is no volume.
 */
export function profileStats(p: Profile, vaFraction: number): ProfileStats | null {
  if (!(p.total > 0)) return null;
  let poc = 0;
  for (let r = 1; r < p.rows; r++) if (p.bins[r] > p.bins[poc]) poc = r;
  const bw = (p.hi - p.lo) / p.rows;
  const need = Math.min(1, Math.max(0, vaFraction)) * p.total - 1e-9 * p.total;
  let up = poc;
  let down = poc;
  let area = p.bins[poc];
  while (area < need && (up > 0 || down < p.rows - 1)) {
    const above = up > 0 ? p.bins[up - 1] : -1;
    const below = down < p.rows - 1 ? p.bins[down + 1] : -1;
    if (above >= below) area += p.bins[--up];
    else area += p.bins[++down];
  }
  return {
    pocRow: poc,
    pocPrice: p.hi - (poc + 0.5) * bw,
    pocVolume: p.bins[poc],
    vahRow: up,
    valRow: down,
    vah: p.hi - up * bw,
    val: p.hi - (down + 1) * bw,
    vaVolume: area,
  };
}

export function parseVpConfig(raw: unknown): VpConfig {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const int = (v: unknown, lo: number, hi: number, def: number) => (typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : def);
  return {
    enabled: typeof o.enabled === "boolean" ? o.enabled : DEFAULT_VP.enabled,
    rows: int(o.rows, VP_MIN_ROWS, VP_MAX_ROWS, DEFAULT_VP.rows),
    va: int(o.va, VP_MIN_VA, VP_MAX_VA, DEFAULT_VP.va),
  };
}

const KEY = "lifeinception.terminal.chart.vp.v1";
export function loadVpConfig(): VpConfig {
  try {
    const s = window.localStorage.getItem(KEY);
    return parseVpConfig(s ? JSON.parse(s) : null);
  } catch {
    return { ...DEFAULT_VP };
  }
}
export function saveVpConfig(cfg: VpConfig): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(cfg));
  } catch {
    /* storage may be blocked; the setting just won't be remembered */
  }
}
