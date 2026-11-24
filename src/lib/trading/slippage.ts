/**
 * Pre-trade slippage analysis. Uses the exact same sweep() the fill engine uses, against the same
 * (depletion-adjusted) book, so the estimate for an order is what that order would get right now.
 * The book can still move between estimate and submit; this is an estimate, not a guarantee.
 */
import { dpFor, fmt, fmtQty, sweep, type Quotes, type Side } from "./engine";

/** Price impact vs. the best price on the side being hit, in basis points (1 bp = 0.01%). */
export const SLIPPAGE_WARN_BPS = 10;
export const SLIPPAGE_SEVERE_BPS = 30;
/** Share of the visible liquidity on that side the order would consume. */
export const SHARE_WARN = 0.5;
export const SHARE_SEVERE = 0.8;
/** A spread wider than this (bps of mid) is itself worth flagging on a marketable order. */
export const SPREAD_WARN_BPS = 10;

export type Severity = "none" | "info" | "warn" | "severe" | "blocked";

export interface SlippageEstimate {
  severity: Severity;
  /** Whether real depth data backs the estimate (false for the simulated feed). */
  hasDepth: boolean;
  requested: number;
  /** Quantity that would execute immediately. */
  filled: number;
  avg: number;
  best: number;
  worst: number | null; // price of the deepest level touched
  levels: number;
  slipPrice: number; // |avg - best|, price units
  slipBps: number;
  slipCost: number; // quote-currency cost of the slippage on the filled quantity
  share: number | null; // fraction of visible side liquidity consumed (null without depth)
  spreadBps: number;
  /** Things worth worrying about (drive severity). */
  reasons: string[];
  /** Neutral context that doesn't change severity. */
  notes: string[];
}

export function estimateSlippage(
  m: Quotes,
  sym: string,
  side: Side,
  qty: number,
  limit?: number
): SlippageEstimate | null {
  if (!(qty > 0) || !Number.isFinite(qty) || !m.price[sym]) return null;
  if (limit !== undefined && !(limit > 0)) return null;

  const dp = dpFor(sym);
  const sw = sweep(m, sym, side, qty, limit);
  const book = m.depth?.(sym) ?? null;
  const hasDepth = !!book;
  const bid = m.bid(sym);
  const ask = m.ask(sym);
  const mid = (bid + ask) / 2;
  const spreadBps = mid > 0 ? ((ask - bid) / mid) * 1e4 : 0;

  const filled = sw.qty;
  const shortfall = qty - filled;
  const isMarket = limit === undefined;
  const slipPrice = filled > 0 ? Math.abs(sw.avg - sw.best) : 0;
  const slipBps = filled > 0 && sw.best > 0 ? (slipPrice / sw.best) * 1e4 : 0;
  const slipCost = slipPrice * filled;

  const sideLevels = book ? (side === "BUY" ? book.asks : book.bids) : null;
  const visible = sideLevels ? sideLevels.reduce((s, [, q]) => s + q, 0) : null;
  const share = visible === null ? null : visible > 0 ? Math.min(1, filled / visible) : 1;
  const worst = sw.taken.length ? sw.taken[sw.taken.length - 1][0] : null;
  const sideName = side === "BUY" ? "ask" : "bid";

  const reasons: string[] = [];
  const notes: string[] = [];
  let severity: Severity = "none";

  if (isMarket && shortfall > 1e-9) {
    severity = "blocked";
    reasons.push(`Only ${fmtQty(filled)} of ${fmtQty(qty)} is available in the visible book, so a market order this size will be rejected.`);
  } else if (filled > 0) {
    if (hasDepth && (sw.levels > 1 || slipBps >= SLIPPAGE_WARN_BPS)) {
      reasons.push(
        `Walks ${sw.levels} book level${sw.levels === 1 ? "" : "s"}: avg ${fmt(sw.avg, dp)} vs best ${fmt(sw.best, dp)} (${slipBps.toFixed(1)} bps)` +
          (worst !== null && sw.levels > 1 ? `, worst fill ${fmt(worst, dp)}` : "")
      );
    }
    if (share !== null && share >= SHARE_WARN) {
      reasons.push(`Takes ${(share * 100).toFixed(0)}% of the visible ${sideName} liquidity`);
    }
    if (spreadBps >= SPREAD_WARN_BPS) {
      reasons.push(`Wide spread: ${spreadBps.toFixed(1)} bps between bid and ask`);
    }
    if (slipBps >= SLIPPAGE_SEVERE_BPS || (share !== null && share >= SHARE_SEVERE)) severity = "severe";
    else if (slipBps >= SLIPPAGE_WARN_BPS || (share !== null && share >= SHARE_WARN) || spreadBps >= SPREAD_WARN_BPS) severity = "warn";
    else severity = "info";
    // multi-level walks below the warn threshold are shown as a note, not an alarm
    if (severity === "info") {
      notes.push(...reasons.splice(0));
    }
    if (!isMarket && shortfall > 1e-9) {
      notes.push(`Only ${fmtQty(filled)} is marketable now; the remaining ${fmtQty(shortfall)} would rest as a limit order.`);
    }
  }

  return { severity, hasDepth, requested: qty, filled, avg: sw.avg, best: sw.best, worst, levels: sw.levels, slipPrice, slipBps, slipCost, share, spreadBps, reasons, notes };
}

/** One-line description for the command line. */
export function slippageLine(e: SlippageEstimate): string {
  return `est. slippage ${e.slipBps.toFixed(1)} bps${e.reasons.length ? `: ${e.reasons.join("; ")}` : ""}`;
}
