/**
 * Chart timeframes: the interval lists, candle aggregation / live folding, time formatting and the
 * remembered selection. Pure functions here are unit-tested; only the last two touch localStorage.
 */
import type { Candle } from "./engine";

export interface Timeframe {
  id: string; // stable id; for Binance this is the exact REST/WS interval string
  label: string;
  ms: number;
}

/** Most candles kept per symbol+timeframe (scrolled-back history plus live candles). */
export const MAX_CANDLES = 10_000;

export const SEC = 1000;
export const MIN = 60 * SEC;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

/** Intervals Binance spot klines support (these ids are sent to the API verbatim). */
export const BINANCE_TIMEFRAMES: Timeframe[] = [
  { id: "1m", label: "1m", ms: MIN },
  { id: "5m", label: "5m", ms: 5 * MIN },
  { id: "15m", label: "15m", ms: 15 * MIN },
  { id: "1h", label: "1h", ms: HOUR },
  { id: "4h", label: "4h", ms: 4 * HOUR },
  { id: "1d", label: "1D", ms: DAY },
];

/** The simulated feed builds a candle every 3s; higher timeframes are aggregated from those. */
export const SIM_TIMEFRAMES: Timeframe[] = [
  { id: "3s", label: "3s", ms: 3 * SEC },
  { id: "15s", label: "15s", ms: 15 * SEC },
  { id: "30s", label: "30s", ms: 30 * SEC },
  { id: "1m", label: "1m", ms: MIN },
  { id: "5m", label: "5m", ms: 5 * MIN },
];

/** Start of the bucket (aligned to the Unix epoch, i.e. UTC) that contains time `t`. */
export const bucketStart = (t: number, ms: number): number => Math.floor(t / ms) * ms;

/** Merge candles (sorted by time) into `ms`-sized buckets. */
export function aggregateByTime(candles: Candle[], ms: number): Candle[] {
  const out: Candle[] = [];
  for (const c of candles) {
    const bt = bucketStart(c.t, ms);
    const last = out[out.length - 1];
    if (last && last.t === bt) {
      last.h = Math.max(last.h, c.h);
      last.l = Math.min(last.l, c.l);
      last.c = c.c;
    } else {
      out.push({ t: bt, o: c.o, h: c.h, l: c.l, c: c.c });
    }
  }
  return out;
}

/**
 * Fold a live 1m candle update into a higher-timeframe candle list, in place. The 1m stream sends
 * the in-progress candle repeatedly, so high/low only ever widen and the close tracks the latest.
 * Updates older than the newest bucket are ignored. The list is trimmed to `max` candles.
 */
export function foldCandle(list: Candle[], ms: number, k: Candle, max = MAX_CANDLES): void {
  const bt = bucketStart(k.t, ms);
  const last = list[list.length - 1];
  if (last && last.t === bt) {
    last.h = Math.max(last.h, k.h);
    last.l = Math.min(last.l, k.l);
    last.c = k.c;
  } else if (!last || bt > last.t) {
    list.push({ t: bt, o: k.o, h: k.h, l: k.l, c: k.c });
    if (list.length > max) list.shift();
  }
}

/**
 * Replace the newest part of `existing` with `fresh` (a just-fetched latest window), keeping any
 * older history we already hold. Used to resync after a reconnect without losing scrolled-back data.
 */
export function mergeLatest(existing: Candle[], fresh: Candle[], max = MAX_CANDLES): Candle[] {
  if (fresh.length === 0) return existing;
  const out = existing.filter((c) => c.t < fresh[0].t).concat(fresh);
  return out.length > max ? out.slice(out.length - max) : out;
}

/** `older` candles (any order) strictly before the first of `existing`, oldest first, ready to prepend. */
export function olderThan(existing: Candle[], older: Candle[]): Candle[] {
  const first = existing.length ? existing[0].t : Infinity;
  return older.filter((c) => c.t < first).sort((a, b) => a.t - b.t);
}

const p2 = (n: number) => String(n).padStart(2, "0");
const ymdUTC = (d: Date) => `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
const ymdLocal = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const hmLocal = (d: Date) => `${p2(d.getHours())}:${p2(d.getMinutes())}`;

/** Short label for an x-axis tick. Daily candles are UTC days, intraday are local time. */
export function formatAxisTime(t: number, ms: number): string {
  const d = new Date(t);
  if (ms >= DAY) return ymdUTC(d).slice(5); // MM-DD
  if (ms >= HOUR) return `${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${hmLocal(d)}`;
  if (ms < MIN) return `${hmLocal(d)}:${p2(d.getSeconds())}`;
  return hmLocal(d);
}

/** Full label for the crosshair readout. */
export function formatFullTime(t: number, ms: number): string {
  const d = new Date(t);
  if (ms >= DAY) return `${ymdUTC(d)} UTC`;
  return `${ymdLocal(d)} ${hmLocal(d)}${ms < MIN ? `:${p2(d.getSeconds())}` : ""}`;
}

// ── remembered selection (per data source) ───────────────────────────────────

const key = (source: string) => `lifeinception.terminal.timeframe.v1.${source}`;

/** The saved timeframe id if it is still one of `valid`, else null. */
export function loadTimeframeId(source: string, valid: Timeframe[]): string | null {
  try {
    const id = localStorage.getItem(key(source));
    return id && valid.some((t) => t.id === id) ? id : null;
  } catch {
    return null;
  }
}

export function saveTimeframeId(source: string, id: string): void {
  try {
    localStorage.setItem(key(source), id);
  } catch {
    /* storage blocked or full: the choice just won't survive a refresh */
  }
}
