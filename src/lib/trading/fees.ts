/**
 * Fee schedule for the paper account: Binance-style spot tiers, the BNB discount, or custom rates.
 * Tier numbers are approximate and Binance changes them, so a Custom option is always available.
 * The preference is stored separately from the account (it is a setting, not account state).
 */

export interface FeeTier {
  id: string;
  label: string;
  maker: number; // percent, e.g. 0.1 means 0.1%
  taker: number;
}

export const FEE_TIERS: FeeTier[] = [
  { id: "regular", label: "Regular", maker: 0.1, taker: 0.1 },
  { id: "vip1", label: "VIP 1", maker: 0.09, taker: 0.1 },
  { id: "vip2", label: "VIP 2", maker: 0.08, taker: 0.1 },
  { id: "vip3", label: "VIP 3", maker: 0.042, taker: 0.06 },
  { id: "vip4", label: "VIP 4", maker: 0.042, taker: 0.054 },
  { id: "vip5", label: "VIP 5", maker: 0.036, taker: 0.048 },
  { id: "zero", label: "No fees", maker: 0, taker: 0 },
];

export const BNB_DISCOUNT = 0.25; // paying fees in BNB takes 25% off
export const MAX_CUSTOM_PCT = 2;

export interface FeeConfig {
  tier: string; // a FEE_TIERS id, or "custom"
  bnb: boolean; // BNB discount (ignored for custom, where you enter the effective rate)
  custom: { maker: number; taker: number }; // percent
}

export const DEFAULT_FEE_CONFIG: FeeConfig = { tier: "regular", bnb: false, custom: { maker: 0.1, taker: 0.1 } };

export interface FeeRates {
  maker: number; // fractions of notional, e.g. 0.001
  taker: number;
}

const clampPct = (x: unknown, fallback: number): number =>
  typeof x === "number" && Number.isFinite(x) ? Math.min(Math.max(x, 0), MAX_CUSTOM_PCT) : fallback;

/** Turn a config into the fractional rates the engine charges. */
export function ratesFor(cfg: FeeConfig): FeeRates {
  if (cfg.tier === "custom") {
    return { maker: clampPct(cfg.custom.maker, 0.1) / 100, taker: clampPct(cfg.custom.taker, 0.1) / 100 };
  }
  const t = FEE_TIERS.find((x) => x.id === cfg.tier) ?? FEE_TIERS[0];
  const k = cfg.bnb ? 1 - BNB_DISCOUNT : 1;
  return { maker: (t.maker / 100) * k, taker: (t.taker / 100) * k };
}

/** Sanitise untrusted stored JSON; anything unusable falls back to the default. */
export function parseFeeConfig(raw: unknown): FeeConfig {
  const r = raw as Partial<FeeConfig> | null;
  if (!r || typeof r !== "object") return DEFAULT_FEE_CONFIG;
  const known = r.tier === "custom" || FEE_TIERS.some((t) => t.id === r.tier);
  return {
    tier: known ? (r.tier as string) : DEFAULT_FEE_CONFIG.tier,
    bnb: r.bnb === true,
    custom: {
      maker: clampPct(r.custom?.maker, DEFAULT_FEE_CONFIG.custom.maker),
      taker: clampPct(r.custom?.taker, DEFAULT_FEE_CONFIG.custom.taker),
    },
  };
}

/** 0.001 -> "0.1%", 0.00075 -> "0.075%", 0 -> "0%". */
export function fmtRate(r: number): string {
  return `${parseFloat((r * 100).toFixed(4))}%`;
}

export function feeLabel(cfg: FeeConfig): string {
  if (cfg.tier === "custom") return "Custom";
  const t = FEE_TIERS.find((x) => x.id === cfg.tier) ?? FEE_TIERS[0];
  return cfg.bnb ? `${t.label} + BNB` : t.label;
}

const KEY = "lifeinception.terminal.fees.v1";

export function loadFeeConfig(): FeeConfig {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? parseFeeConfig(JSON.parse(raw)) : DEFAULT_FEE_CONFIG;
  } catch {
    return DEFAULT_FEE_CONFIG;
  }
}

export function saveFeeConfig(cfg: FeeConfig): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(cfg));
  } catch {
    /* storage blocked or full: the setting just won't survive a refresh */
  }
}
