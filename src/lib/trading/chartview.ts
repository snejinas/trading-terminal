/**
 * Viewport math for the candlestick chart: how many candles are visible (zoom) and how far back
 * from the newest candle the window sits (scroll). Pure functions, unit-tested.
 *
 * `offset` is measured in candles from the right edge (0 = live edge) and may be fractional, so
 * panning is smooth. Measuring from the right end means loading older history at the left never
 * moves the window; `appendedSince` handles the other direction (new candles at the right).
 */
import type { Candle } from "./engine";

export interface View {
  /** Visible candles; null = automatic (follows the chart width). */
  count: number | null;
  offset: number;
}

export const MIN_COUNT = 8;
export const MAX_COUNT = 600;
/** When scrolled all the way back, this share of the window is still filled with candles. */
const MIN_FILLED = 0.25;

const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);

/** The automatic zoom level: roughly one candle per 8px, between 20 and 90 candles. */
export const defaultCount = (plotW: number): number => clamp(Math.floor(plotW / 8), 20, 90);

export const resolveCount = (v: View, plotW: number): number =>
  v.count === null ? defaultCount(plotW) : clamp(Math.round(v.count), MIN_COUNT, MAX_COUNT);

/** Furthest back you can scroll: the oldest candles may reach the window's right quarter. */
export const maxOffset = (len: number, count: number): number => Math.max(0, len - Math.ceil(count * MIN_FILLED));

export const clampOffset = (offset: number, count: number, len: number): number =>
  clamp(Number.isFinite(offset) ? offset : 0, 0, maxOffset(len, count));

/** Float index of the window's left edge (negative when the history is shorter than the window). */
export const windowStart = (len: number, offset: number, count: number): number => len - offset - count;

/**
 * Zoom by `factor` (>1 shows more candles, <1 fewer) keeping the candle under `anchorFrac`
 * (0 = left edge of the plot, 1 = right edge) where it is.
 */
export function zoomAt(
  view: View,
  count: number,
  len: number,
  anchorFrac: number,
  factor: number
): { count: number; offset: number } {
  const f = clamp(Number.isFinite(anchorFrac) ? anchorFrac : 1, 0, 1);
  const next = clamp(Math.round(count * (Number.isFinite(factor) && factor > 0 ? factor : 1)), MIN_COUNT, MAX_COUNT);
  if (next === count) return { count, offset: clampOffset(view.offset, count, len) };
  const anchor = windowStart(len, view.offset, count) + f * count; // index under the cursor
  const offset = len - anchor - (1 - f) * next;
  return { count: next, offset: clampOffset(offset, next, len) };
}

/**
 * Compact volume label: 0.045, 3.21, 87.40, 743, 12.3K, 4.56M, 2.50B. Tiny non-zero values read
 * "<0.001", and rounding never prints "1000.0K": it rolls over into the next unit ("1.00M").
 */
export function formatVolume(v: number): string {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return "0";
  if (v < 0.001) return "<0.001";
  const tiers: [number, string, number][] = [
    [1e9, "B", 2],
    [1e6, "M", 2],
    [1e3, "K", 1],
  ];
  for (const [div, suffix, dp] of tiers) {
    if (v < div) continue;
    const s = (v / div).toFixed(dp);
    return parseFloat(s) >= 1000 && suffix !== "B" ? formatVolume(div * 1000) : `${s}${suffix}`;
  }
  const s = v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toFixed(3);
  return parseFloat(s) >= 1000 ? "1.0K" : s;
}

const VOLUME_KEY = "lifeinception.terminal.chart.volume.v1";

/** Whether the volume pane is shown (default on). */
export function loadVolumePref(): boolean {
  try {
    return localStorage.getItem(VOLUME_KEY) !== "off";
  } catch {
    return true;
  }
}

export function saveVolumePref(on: boolean): void {
  try {
    localStorage.setItem(VOLUME_KEY, on ? "on" : "off");
  } catch {
    /* storage blocked or full: the preference just won't survive a refresh */
  }
}

/** Candles appended at the right since the newest candle we last saw had time `lastT`. */
export function appendedSince(all: Candle[], lastT: number): number {
  let n = 0;
  for (let i = all.length - 1; i >= 0 && all[i].t > lastT; i--) n++;
  return n;
}
