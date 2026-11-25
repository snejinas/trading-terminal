// Fibonacci retracement: levels, time/price anchors, hit-testing and per-symbol persistence.
// Anchors are stored as (candle time, price) so a retracement survives zooming, scrolling and timeframe changes.

export interface FibPoint {
  t: number; // ms since epoch (snapped to a candle open time when placed)
  p: number; // price
}
export interface Fib {
  id: string;
  a: FibPoint; // where the move started (level 1)
  b: FibPoint; // where it ended (level 0)
}

export const FIB_RETRACEMENTS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1] as const;
export const FIB_EXTENSIONS = [1.272, 1.618, 2.618] as const;
export const FIB_MAX_PER_SYMBOL = 20;
export const FIB_COLORS: Record<string, string> = {
  "0": "#94a3b8",
  "0.236": "#f87171",
  "0.382": "#fb923c",
  "0.5": "#4ade80",
  "0.618": "#22d3ee",
  "0.786": "#60a5fa",
  "1": "#94a3b8",
};
export const FIB_EXT_COLOR = "#c084fc";
export const fibColor = (r: number) => FIB_COLORS[String(r)] ?? FIB_EXT_COLOR;
export const fibLevels = (extensions: boolean): number[] => [...FIB_RETRACEMENTS, ...(extensions ? FIB_EXTENSIONS : [])];

/** Level 0 is the end of the move (b), level 1 its start (a); ratios above 1 extend beyond the start. */
export const levelPrice = (f: Pick<Fib, "a" | "b">, ratio: number): number => f.b.p - (f.b.p - f.a.p) * ratio;

export const fibRatioLabel = (r: number): string => String(r);

type Timed = { t: number };

/** Fractional candle index of a time: linear between candles, extrapolated by `tfMs` outside the loaded range. */
export function timeToIndex(all: ArrayLike<Timed>, t: number, tfMs: number): number {
  const n = all.length;
  if (n === 0) return 0;
  const step = tfMs > 0 ? tfMs : 60_000;
  if (t >= all[n - 1].t) return n - 1 + (t - all[n - 1].t) / step;
  if (t <= all[0].t) return (t - all[0].t) / step;
  let lo = 0;
  let hi = n - 1; // all[lo].t <= t < all[hi].t
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (all[mid].t <= t) lo = mid;
    else hi = mid;
  }
  return lo + (t - all[lo].t) / (all[hi].t - all[lo].t);
}

/** Inverse of timeToIndex. */
export function indexToTime(all: ArrayLike<Timed>, idx: number, tfMs: number): number {
  const n = all.length;
  if (n === 0) return 0;
  const step = tfMs > 0 ? tfMs : 60_000;
  if (idx <= 0) return all[0].t + idx * step;
  if (idx >= n - 1) return all[n - 1].t + (idx - (n - 1)) * step;
  const i = Math.floor(idx);
  return all[i].t + (idx - i) * (all[i + 1].t - all[i].t);
}

/** The time of the candle (or the slot beyond the loaded range) nearest to a fractional index. */
export const snapTime = (all: ArrayLike<Timed>, idx: number, tfMs: number): number => indexToTime(all, Math.round(idx), tfMs);

/** The closest point within `radius` of (x, y), or null. Later entries win ties (they are drawn on top). */
export function nearestHandle<T extends { x: number; y: number }>(points: T[], x: number, y: number, radius: number): T | null {
  let best: T | null = null;
  let bestD = radius * radius;
  for (const p of points) {
    const d = (p.x - x) ** 2 + (p.y - y) ** 2;
    if (d <= bestD) {
      best = p;
      bestD = d;
    }
  }
  return best;
}

const okPoint = (v: unknown): v is FibPoint => {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.t === "number" && Number.isFinite(o.t) && o.t >= 0 && o.t < 4e12 && typeof o.p === "number" && Number.isFinite(o.p);
};

/** Keeps only well-formed retracements (at most FIB_MAX_PER_SYMBOL), with unique ids. */
export function parseFibs(raw: unknown): Fib[] {
  if (!Array.isArray(raw)) return [];
  const out: Fib[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (out.length >= FIB_MAX_PER_SYMBOL) break;
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    if (!okPoint(o.a) || !okPoint(o.b)) continue;
    if (o.a.t === o.b.t && o.a.p === o.b.p) continue; // a retracement needs some extent
    let id = typeof o.id === "string" && o.id.length > 0 && o.id.length <= 40 ? o.id : `f${out.length}`;
    while (seen.has(id)) id += "_";
    seen.add(id);
    out.push({ id, a: { t: o.a.t, p: o.a.p }, b: { t: o.b.t, p: o.b.p } });
  }
  return out;
}

const key = (sym: string) => `lifeinception.terminal.chart.fib.v1.${sym}`;
const EXT_KEY = "lifeinception.terminal.chart.fib.ext.v1";

export function loadFibs(sym: string): Fib[] {
  try {
    const s = window.localStorage.getItem(key(sym));
    return parseFibs(s ? JSON.parse(s) : null);
  } catch {
    return [];
  }
}

export function saveFibs(sym: string, fibs: Fib[]): void {
  try {
    if (fibs.length === 0) window.localStorage.removeItem(key(sym));
    else window.localStorage.setItem(key(sym), JSON.stringify(fibs));
  } catch {
    /* storage may be blocked; the drawings just won't be remembered */
  }
}

export function loadFibExtensions(): boolean {
  try {
    return window.localStorage.getItem(EXT_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveFibExtensions(on: boolean): void {
  try {
    window.localStorage.setItem(EXT_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

let counter = 0;
export const newFibId = (): string => `f${Date.now().toString(36)}${(counter++).toString(36)}`;
