/**
 * Export / import of the paper account as a JSON file. The file is untrusted input on import:
 * it is size-limited, envelope-checked, and then run through Account.restore(), which validates
 * every field. Fee tier is a setting and is deliberately not part of a backup.
 */
import { Account, type AccountSnapshot } from "./engine";
import type { SourceKey } from "./storage";

export const BACKUP_KIND = "lifeinception-paper-account";
export const MAX_BACKUP_BYTES = 5 * 1024 * 1024;
export const MAX_BACKUP_ORDERS = 500;

export interface BackupFile {
  kind: typeof BACKUP_KIND;
  version: 1;
  exportedAt: string; // ISO timestamp
  source: SourceKey;
  account: AccountSnapshot;
}

export interface BackupSummary {
  exportedAt: string;
  source: SourceKey;
  cash: number;
  realized: number;
  fees: number;
  positions: number;
  orders: number;
  fills: number;
}

export type ParseResult =
  | { ok: true; account: Account; dropped: number; summary: BackupSummary }
  | { ok: false; error: string };

export const sourceName = (s: SourceKey): string => (s === "binance" ? "Binance" : "simulated");

export function buildBackup(source: SourceKey, account: Account, now: Date = new Date()): BackupFile {
  return { kind: BACKUP_KIND, version: 1, exportedAt: now.toISOString(), source, account: account.snapshot() };
}

export function backupFilename(source: SourceKey, now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const d = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  return `paper-account-${source}-${d}.json`;
}

export function parseBackup(text: string, source: SourceKey, validSyms: Set<string>): ParseResult {
  if (text.length > MAX_BACKUP_BYTES) return { ok: false, error: "That file is too large to be a paper-account backup." };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "That file isn't valid JSON." };
  }
  const b = raw as Partial<BackupFile> | null;
  if (!b || typeof b !== "object" || b.kind !== BACKUP_KIND) {
    return { ok: false, error: "That doesn't look like a paper-account backup exported from this terminal." };
  }
  if (b.version !== 1) return { ok: false, error: `Unsupported backup version (${String(b.version)}).` };
  if (b.source !== "binance" && b.source !== "sim") return { ok: false, error: "The backup doesn't say which data feed it was taken on." };
  if (b.source !== source) {
    return {
      ok: false,
      error: `This backup was taken on the ${sourceName(b.source)} feed, but you're on the ${sourceName(source)} feed. Positions use different symbols, so it can't be loaded here.`,
    };
  }
  const acct = b.account as Partial<AccountSnapshot> | undefined;
  if (acct && Array.isArray(acct.orders) && acct.orders.length > MAX_BACKUP_ORDERS) {
    return { ok: false, error: "The backup has an unreasonable number of working orders." };
  }
  const res = Account.restore(acct, validSyms);
  if (!res) return { ok: false, error: "The account data in this file is invalid or corrupted." };
  const a = res.account;
  return {
    ok: true,
    account: a,
    dropped: res.dropped,
    summary: {
      exportedAt: typeof b.exportedAt === "string" ? b.exportedAt : "",
      source: b.source,
      cash: a.cash,
      realized: a.realized,
      fees: a.fees,
      positions: Object.keys(a.positions).length,
      orders: a.orders.length,
      fills: a.fills.length,
    },
  };
}
