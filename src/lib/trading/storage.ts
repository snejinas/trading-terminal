/**
 * Browser persistence for the paper account. One account per data source, because
 * Binance pairs (BTCUSDT) and simulated tickers (AAPL) are different universes.
 * Everything is wrapped in try/catch: storage can be blocked or full (private mode, quota).
 */
import { Account } from "./engine";

export type SourceKey = "binance" | "sim";

export const storageKey = (source: SourceKey): string => `lifeinception.terminal.account.v1.${source}`;

export function loadAccount(source: SourceKey, validSyms: Set<string>): { account: Account; dropped: number } | null {
  try {
    const raw = localStorage.getItem(storageKey(source));
    return raw ? Account.restore(JSON.parse(raw), validSyms) : null;
  } catch {
    return null;
  }
}

export function parseAccount(raw: string, validSyms: Set<string>): { account: Account; dropped: number } | null {
  try {
    return Account.restore(JSON.parse(raw), validSyms);
  } catch {
    return null;
  }
}

export function saveAccount(source: SourceKey, account: Account): boolean {
  try {
    localStorage.setItem(storageKey(source), JSON.stringify(account.snapshot()));
    return true;
  } catch {
    return false;
  }
}
