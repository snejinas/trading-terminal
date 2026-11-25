// Moving-average indicators for the chart. Pure functions plus a small, defensive settings layer.
import type { Candle } from "./engine";

export type MaType = "sma" | "ema";
export interface MaSlot {
  type: MaType;
  period: number;
  enabled: boolean;
}

export const MA_MIN_PERIOD = 1;
export const MA_MAX_PERIOD = 500;
export const MA_COLORS = ["#f5a524", "#a78bfa", "#38bdf8"] as const;
export const DEFAULT_MAS: MaSlot[] = [
  { type: "sma", period: 20, enabled: true },
  { type: "sma", period: 50, enabled: true },
  { type: "ema", period: 200, enabled: false },
];
const KEY = "lifeinception.terminal.chart.ma.v1";

/** Simple moving average; entries before `period` values exist are null. Non-finite inputs null their window. */
export function sma(values: number[], period: number): (number | null)[] {
  const n = values.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (!Number.isInteger(period) || period < 1) return out;
  let sum = 0;
  let bad = 0; // non-finite values currently inside the window
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (Number.isFinite(v)) sum += v;
    else bad++;
    if (i >= period) {
      const old = values[i - period];
      if (Number.isFinite(old)) sum -= old;
      else bad--;
    }
    if (i >= period - 1 && bad === 0) out[i] = sum / period;
  }
  return out;
}

/** Exponential moving average seeded with the SMA of the first `period` values (alpha = 2 / (period + 1)). */
export function ema(values: number[], period: number): (number | null)[] {
  const n = values.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (!Number.isInteger(period) || period < 1 || n < period) return out;
  const alpha = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) {
    if (!Number.isFinite(values[i])) return out; // cannot seed on garbage
    seed += values[i];
  }
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < n; i++) {
    const v = values[i];
    if (Number.isFinite(v)) prev = prev + alpha * (v - prev);
    out[i] = prev; // a bad value holds the previous average
  }
  return out;
}

export function movingAverage(candles: Candle[], slot: Pick<MaSlot, "type" | "period">): (number | null)[] {
  const closes = candles.map((c) => c.c);
  return slot.type === "ema" ? ema(closes, slot.period) : sma(closes, slot.period);
}

/** One series per slot; disabled slots are null (not computed). */
export function computeMovingAverages(candles: Candle[], slots: MaSlot[]): ((number | null)[] | null)[] {
  return slots.map((s) => (s.enabled ? movingAverage(candles, s) : null));
}

export const maLabel = (s: Pick<MaSlot, "type" | "period">) => `${s.type === "ema" ? "EMA" : "SMA"} ${s.period}`;

/** Always returns exactly three valid slots, taking whatever parts of `raw` are usable. */
export function parseMaConfig(raw: unknown): MaSlot[] {
  const list = Array.isArray(raw) ? raw : [];
  return DEFAULT_MAS.map((def, i) => {
    const r = list[i];
    if (!r || typeof r !== "object") return { ...def };
    const o = r as Record<string, unknown>;
    const period = typeof o.period === "number" && Number.isInteger(o.period) && o.period >= MA_MIN_PERIOD && o.period <= MA_MAX_PERIOD ? o.period : def.period;
    return {
      type: o.type === "ema" || o.type === "sma" ? o.type : def.type,
      period,
      enabled: typeof o.enabled === "boolean" ? o.enabled : def.enabled,
    };
  });
}

export function loadMaConfig(): MaSlot[] {
  try {
    const s = window.localStorage.getItem(KEY);
    return parseMaConfig(s ? JSON.parse(s) : null);
  } catch {
    return DEFAULT_MAS.map((d) => ({ ...d }));
  }
}

export function saveMaConfig(slots: MaSlot[]): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(slots));
  } catch {
    /* storage may be blocked; the setting just won't be remembered */
  }
}

// ───────── Bollinger Bands ─────────
export interface BbConfig {
  enabled: boolean;
  period: number;
  mult: number; // band half-width in standard deviations
}
export const BB_MIN_MULT = 0.1;
export const BB_MAX_MULT = 10;
export const BB_COLOR = "#64d2c8";
export const BB_FILL = "rgba(100,210,200,0.09)";
export const DEFAULT_BB: BbConfig = { enabled: false, period: 20, mult: 2 };
const BB_KEY = "lifeinception.terminal.chart.bb.v1";

export interface Bands {
  mid: (number | null)[];
  upper: (number | null)[];
  lower: (number | null)[];
}

/**
 * Bollinger Bands: SMA(period) ± mult × population standard deviation of the same window.
 * Each window is computed directly (two passes) rather than from running sums, which lose precision
 * on large prices with tiny variance. Windows containing a non-finite value are null.
 */
export function bollinger(values: number[], period: number, mult: number): Bands {
  const n = values.length;
  const mid: (number | null)[] = new Array(n).fill(null);
  const upper: (number | null)[] = new Array(n).fill(null);
  const lower: (number | null)[] = new Array(n).fill(null);
  if (!Number.isInteger(period) || period < 1 || !Number.isFinite(mult) || mult < 0) return { mid, upper, lower };
  let lastBad = -1; // index of the newest non-finite value
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(values[i])) lastBad = i;
    if (i < period - 1 || lastBad > i - period) continue;
    let sum = 0;
    for (let k = i - period + 1; k <= i; k++) sum += values[k];
    const mean = sum / period;
    let sq = 0;
    for (let k = i - period + 1; k <= i; k++) sq += (values[k] - mean) ** 2;
    const sd = Math.sqrt(sq / period);
    mid[i] = mean;
    upper[i] = mean + mult * sd;
    lower[i] = mean - mult * sd;
  }
  return { mid, upper, lower };
}

export const bollingerOf = (candles: Candle[], cfg: Pick<BbConfig, "period" | "mult">): Bands =>
  bollinger(candles.map((c) => c.c), cfg.period, cfg.mult);

export const bbLabel = (c: Pick<BbConfig, "period" | "mult">) => `BB ${c.period},${c.mult}`;

export function parseBbConfig(raw: unknown): BbConfig {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const period = typeof o.period === "number" && Number.isInteger(o.period) && o.period >= MA_MIN_PERIOD && o.period <= MA_MAX_PERIOD ? o.period : DEFAULT_BB.period;
  const mult = typeof o.mult === "number" && Number.isFinite(o.mult) && o.mult >= BB_MIN_MULT && o.mult <= BB_MAX_MULT ? o.mult : DEFAULT_BB.mult;
  return { enabled: typeof o.enabled === "boolean" ? o.enabled : DEFAULT_BB.enabled, period, mult };
}

export function loadBbConfig(): BbConfig {
  try {
    const s = window.localStorage.getItem(BB_KEY);
    return parseBbConfig(s ? JSON.parse(s) : null);
  } catch {
    return { ...DEFAULT_BB };
  }
}

export function saveBbConfig(cfg: BbConfig): void {
  try {
    window.localStorage.setItem(BB_KEY, JSON.stringify(cfg));
  } catch {
    /* storage may be blocked; the setting just won't be remembered */
  }
}
