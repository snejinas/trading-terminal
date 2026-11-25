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

// ───────── RSI (the building block of the Stochastic RSI) ─────────
const rsiFrom = (avgGain: number, avgLoss: number): number => {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
};

/**
 * Relative Strength Index with Wilder's smoothing. The first value (at index `period`) uses the plain
 * average of the first `period` price changes; later values smooth with (prev × (period−1) + new) / period.
 * No movement at all reads 50. A non-finite value yields null and the next change spans the gap.
 */
export function rsi(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (!Number.isInteger(period) || period < 2) return out;
  let prev: number | null = null;
  let seen = 0;
  let sumG = 0;
  let sumL = 0;
  let avgG = 0;
  let avgL = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    if (prev === null) {
      prev = v;
      continue;
    }
    const ch = v - prev;
    prev = v;
    const g = ch > 0 ? ch : 0;
    const l = ch < 0 ? -ch : 0;
    if (seen < period) {
      sumG += g;
      sumL += l;
      if (++seen === period) {
        avgG = sumG / period;
        avgL = sumL / period;
        out[i] = rsiFrom(avgG, avgL);
      }
    } else {
      avgG = (avgG * (period - 1) + g) / period;
      avgL = (avgL * (period - 1) + l) / period;
      out[i] = rsiFrom(avgG, avgL);
    }
  }
  return out;
}

// ───────── Stochastic RSI ─────────
export interface StochRsiConfig {
  enabled: boolean;
  rsi: number; // RSI period
  stoch: number; // lookback over which the RSI is placed between its lowest and highest value
  k: number; // SMA applied to the raw value (%K)
  d: number; // SMA of %K (%D)
}
export const STOCHRSI_MIN_PERIOD = 2;
export const STOCHRSI_MAX_PERIOD = 200;
export const STOCHRSI_MAX_SMOOTH = 50;
export const STOCHRSI_K_COLOR = "#22d3ee";
export const STOCHRSI_D_COLOR = "#e879f9";
export const STOCHRSI_OVERBOUGHT = 80;
export const STOCHRSI_OVERSOLD = 20;
export const DEFAULT_STOCHRSI: StochRsiConfig = { enabled: false, rsi: 14, stoch: 14, k: 3, d: 3 };
const STOCHRSI_KEY = "lifeinception.terminal.chart.stochrsi.v1";

/** SMA over a series that may contain nulls; a window containing a null is null. */
function smaNullable(values: (number | null)[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  let lastNull = -1;
  for (let i = 0; i < values.length; i++) {
    if (values[i] === null) lastNull = i;
    if (i < period - 1 || lastNull > i - period) continue;
    let sum = 0;
    for (let k = i - period + 1; k <= i; k++) sum += values[k] as number;
    out[i] = sum / period;
  }
  return out;
}

/**
 * Stochastic RSI: where the RSI sits between its own lowest and highest value over the last `stoch` readings,
 * 0-100 (50 when the RSI did not move at all in that window). %K = SMA(raw, k); %D = SMA(%K, d).
 * It is more sensitive than the RSI and swings between its extremes far more often.
 */
export function stochRsi(closes: number[], rsiPeriod: number, stochPeriod: number, kSmooth: number, dSmooth: number): { k: (number | null)[]; d: (number | null)[] } {
  const r = rsi(closes, rsiPeriod);
  const n = r.length;
  const raw: (number | null)[] = new Array(n).fill(null);
  const ok = (p: number) => Number.isInteger(p) && p >= 1;
  if (!ok(stochPeriod) || stochPeriod < 2 || !ok(kSmooth) || !ok(dSmooth)) return { k: raw.slice(), d: raw.slice() };
  let lastNull = -1;
  for (let i = 0; i < n; i++) {
    if (r[i] === null) lastNull = i;
    if (i < stochPeriod - 1 || lastNull > i - stochPeriod) continue;
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - stochPeriod + 1; j <= i; j++) {
      const v = r[j] as number;
      if (v > hh) hh = v;
      if (v < ll) ll = v;
    }
    raw[i] = hh === ll ? 50 : Math.min(100, Math.max(0, (100 * ((r[i] as number) - ll)) / (hh - ll)));
  }
  const kk = smaNullable(raw, kSmooth);
  return { k: kk, d: smaNullable(kk, dSmooth) };
}

export const stochRsiOf = (candles: Candle[], c: Pick<StochRsiConfig, "rsi" | "stoch" | "k" | "d">) =>
  stochRsi(candles.map((x) => x.c), c.rsi, c.stoch, c.k, c.d);

export const stochRsiLabel = (c: Pick<StochRsiConfig, "rsi" | "stoch" | "k" | "d">) => `StochRSI ${c.rsi},${c.stoch},${c.k},${c.d}`;

export function parseStochRsiConfig(raw: unknown): StochRsiConfig {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const int = (v: unknown, lo: number, hi: number, def: number) => (typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : def);
  return {
    enabled: typeof o.enabled === "boolean" ? o.enabled : DEFAULT_STOCHRSI.enabled,
    rsi: int(o.rsi, STOCHRSI_MIN_PERIOD, STOCHRSI_MAX_PERIOD, DEFAULT_STOCHRSI.rsi),
    stoch: int(o.stoch, STOCHRSI_MIN_PERIOD, STOCHRSI_MAX_PERIOD, DEFAULT_STOCHRSI.stoch),
    k: int(o.k, 1, STOCHRSI_MAX_SMOOTH, DEFAULT_STOCHRSI.k),
    d: int(o.d, 1, STOCHRSI_MAX_SMOOTH, DEFAULT_STOCHRSI.d),
  };
}

export function loadStochRsiConfig(): StochRsiConfig {
  try {
    const s = window.localStorage.getItem(STOCHRSI_KEY);
    return parseStochRsiConfig(s ? JSON.parse(s) : null);
  } catch {
    return { ...DEFAULT_STOCHRSI };
  }
}

export function saveStochRsiConfig(cfg: StochRsiConfig): void {
  try {
    window.localStorage.setItem(STOCHRSI_KEY, JSON.stringify(cfg));
  } catch {
    /* storage may be blocked; the setting just won't be remembered */
  }
}
