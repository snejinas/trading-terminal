"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BinanceMarket } from "@/lib/trading/binance";
import {
  DEFAULT_FEE_CONFIG,
  FEE_TIERS,
  MAX_CUSTOM_PCT,
  feeLabel,
  fmtRate,
  loadFeeConfig,
  ratesFor,
  saveFeeConfig,
  type FeeConfig,
} from "@/lib/trading/fees";
import {
  MAX_BACKUP_BYTES,
  backupFilename,
  buildBackup,
  parseBackup,
  sourceName,
  type BackupSummary,
} from "@/lib/trading/backup";
import { SLIPPAGE_SEVERE_BPS, estimateSlippage, slippageLine } from "@/lib/trading/slippage";
import { loadAccount, parseAccount, saveAccount, storageKey, type SourceKey } from "@/lib/trading/storage";
import {
  Account,
  Market,
  START_CASH,
  sweep,
  type Fill,
  type Feed,
  dpFor,
  fmt,
  fmtQty,
  type OrderType,
  type Side,
} from "@/lib/trading/engine";

const TICK_MS = 500;
const UP = "#26d07c";
const DOWN = "#ff5b6e";

type Tab = "positions" | "orders" | "fills";

type ImportDlg =
  | { kind: "confirm"; account: Account; dropped: number; summary: BackupSummary }
  | { kind: "error"; message: string }
  | null;

function describeFill(f: Fill): string {
  const dp = dpFor(f.sym);
  // same basis as the ticket estimate: slippage relative to the best price at execution
  const best = f.side === "BUY" ? f.price - f.slip : f.price + f.slip;
  const bps = best > 0 ? (f.slip / best) * 1e4 : 0;
  const walked = f.levels > 1 ? ` across ${f.levels} levels (slippage ${fmt(f.slip, dp)} · ${bps.toFixed(1)} bps)` : "";
  return `${f.side} ${fmtQty(f.qty)} ${f.sym} @ ${fmt(f.price, dp)} avg${walked}, fee ${fmt(f.fee, 4)} (${f.role})`;
}

// ─── Candlestick chart ──────────────────────────────────────────────────────

function Chart({ market, sym }: { market: Feed; sym: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const mouse = useRef<{ x: number; y: number } | null>(null);
  const [, bump] = useState(0);

  const draw = useCallback(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    if (cv.width !== w * dpr || cv.height !== h * dpr) {
      cv.width = w * dpr;
      cv.height = h * dpr;
    }
    const ctx = cv.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const dp = dpFor(sym);
    const axisW = 72;
    const pad = 12;
    const plotW = w - axisW - pad;
    const plotH = h - 24;
    const all = market.candles[sym];
    const n = Math.max(20, Math.min(90, Math.floor(plotW / 8)));
    const data = all.slice(-n);

    let lo = Infinity;
    let hi = -Infinity;
    for (const c of data) {
      lo = Math.min(lo, c.l);
      hi = Math.max(hi, c.h);
    }
    const margin = (hi - lo) * 0.08 || hi * 0.001;
    lo -= margin;
    hi += margin;
    const y = (p: number) => pad + ((hi - p) / (hi - lo)) * (plotH - pad);
    const step = plotW / n;

    ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textBaseline = "middle";

    // grid + price axis
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.fillStyle = "#7d8799";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 5; i++) {
      const p = lo + ((hi - lo) * i) / 5;
      const yy = Math.round(y(p)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, yy);
      ctx.lineTo(plotW, yy);
      ctx.stroke();
      ctx.fillText(fmt(p, dp), plotW + 8, yy);
    }

    // candles
    data.forEach((c, i) => {
      const x = i * step + step / 2;
      const up = c.c >= c.o;
      ctx.strokeStyle = ctx.fillStyle = up ? UP : DOWN;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, y(c.h));
      ctx.lineTo(Math.round(x) + 0.5, y(c.l));
      ctx.stroke();
      const top = y(Math.max(c.o, c.c));
      const bh = Math.max(1, Math.abs(y(c.o) - y(c.c)));
      ctx.fillRect(x - step * 0.32, top, step * 0.64, bh);
    });

    // last price line
    const last = data[data.length - 1];
    const ly = Math.round(y(last.c)) + 0.5;
    const lc = last.c >= last.o ? UP : DOWN;
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = lc;
    ctx.beginPath();
    ctx.moveTo(0, ly);
    ctx.lineTo(plotW, ly);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = lc;
    ctx.fillRect(plotW + 2, ly - 9, axisW - 2, 18);
    ctx.fillStyle = "#0b0e14";
    ctx.fillText(fmt(last.c, dp), plotW + 8, ly);

    // crosshair
    const m = mouse.current;
    if (m && m.x < plotW && m.y < plotH) {
      ctx.strokeStyle = "rgba(255,255,255,0.25)";
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(m.x + 0.5, 0);
      ctx.lineTo(m.x + 0.5, plotH);
      ctx.moveTo(0, m.y + 0.5);
      ctx.lineTo(plotW, m.y + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
      const price = hi - ((m.y - pad) / (plotH - pad)) * (hi - lo);
      ctx.fillStyle = "#2a3140";
      ctx.fillRect(plotW + 2, m.y - 9, axisW - 2, 18);
      ctx.fillStyle = "#e6eaf2";
      ctx.fillText(fmt(price, dp), plotW + 8, m.y);
      const idx = Math.min(data.length - 1, Math.max(0, Math.floor(m.x / step)));
      const c = data[idx];
      ctx.fillStyle = "#aab3c5";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(
        `O ${fmt(c.o, dp)}  H ${fmt(c.h, dp)}  L ${fmt(c.l, dp)}  C ${fmt(c.c, dp)}`,
        8,
        h - 6
      );
      ctx.textBaseline = "middle";
    }
  }, [market, sym]);

  useEffect(() => {
    draw();
    const id = setInterval(draw, TICK_MS);
    const ro = new ResizeObserver(draw);
    if (ref.current) ro.observe(ref.current);
    return () => {
      clearInterval(id);
      ro.disconnect();
    };
  }, [draw]);

  return (
    <canvas
      ref={ref}
      className="h-full w-full"
      onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        mouse.current = { x: e.clientX - r.left, y: e.clientY - r.top };
        draw();
        bump((v) => v + 1);
      }}
      onMouseLeave={() => {
        mouse.current = null;
        draw();
      }}
    />
  );
}

// ─── Order book (synthetic depth around the current price) ──────────────────

function OrderBook({ market, sym, tick }: { market: Feed; sym: string; tick: number }) {
  const dp = dpFor(sym);
  const bid = market.bid(sym);
  const ask = market.ask(sym);
  const live = market.depth?.(sym) ?? null;
  const inc = Math.max(market.spread(sym), market.price[sym] * 0.00005);
  const synth = (dir: 1 | -1) =>
    Array.from({ length: 8 }, (_, i): [number, number] => {
      // stable-ish pseudo size so the book flickers slightly but doesn't jump wildly
      const seed = Math.sin((i + 1) * 12.9898 + tick * 0.35 * (dir === 1 ? 1 : 1.3)) * 43758.5453;
      return [(dir === 1 ? ask : bid) + dir * i * inc, 20 + (seed - Math.floor(seed)) * 480];
    });
  const askLv = (live ? live.asks.slice(0, 8) : synth(1)).map(([price, size]) => ({ price, size }));
  const bidLv = (live ? live.bids.slice(0, 8) : synth(-1)).map(([price, size]) => ({ price, size }));
  // cumulative size so the depth bars read as a depth chart
  const cum = (rows: { price: number; size: number }[]) => {
    let t = 0;
    return rows.map((r) => ({ ...r, total: (t += r.size) }));
  };
  const asks = cum(askLv).reverse();
  const bids = cum(bidLv);
  const max = Math.max(asks[0]?.total ?? 1, bids[bids.length - 1]?.total ?? 1);
  const sdp = market.price[sym] >= 1000 ? 4 : market.price[sym] >= 1 ? 3 : 0;
  const Row = ({ r, color }: { r: { price: number; size: number; total: number }; color: string }) => (
    <div className="relative flex justify-between px-2 py-[2px] text-[11px]">
      <div
        className="absolute inset-y-0 right-0 opacity-15"
        style={{ width: `${(r.total / max) * 100}%`, background: color }}
      />
      <span style={{ color }} className="relative">
        {fmt(r.price, dp)}
      </span>
      <span className="relative text-slate-400">{fmt(r.size, sdp)}</span>
    </div>
  );
  const bidVol = bidLv.reduce((s, r) => s + r.size, 0);
  const askVol = askLv.reduce((s, r) => s + r.size, 0);
  const imb = bidVol + askVol > 0 ? (bidVol / (bidVol + askVol)) * 100 : 50;
  return (
    <div className="font-mono">
      {asks.map((r, i) => (
        <Row key={`a${i}`} r={r} color={DOWN} />
      ))}
      <div className="my-1 border-y border-white/5 px-2 py-1 text-center text-xs text-slate-300">
        spread {fmt(ask - bid, dp)}
      </div>
      {bids.map((r, i) => (
        <Row key={`b${i}`} r={r} color={UP} />
      ))}
      {live && (
        <div className="mt-2 px-2">
          <div className="flex h-1.5 overflow-hidden rounded">
            <div style={{ width: `${imb}%`, background: UP }} />
            <div style={{ width: `${100 - imb}%`, background: DOWN }} />
          </div>
          <div className="mt-1 flex justify-between text-[10px] text-slate-500">
            <span>bids {imb.toFixed(0)}%</span>
            <span>asks {(100 - imb).toFixed(0)}%</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Terminal ───────────────────────────────────────────────────────────────

export default function TradingTerminal() {
  const market = useRef<Feed | null>(null);
  const [source, setSource] = useState<"loading" | "binance" | "sim">("loading");
  const account = useRef<Account | null>(null);
  const [tick, setTick] = useState(0);
  const [sym, setSym] = useState("");
  const [side, setSide] = useState<Side>("BUY");
  const [type, setType] = useState<OrderType>("MKT");
  const [qty, setQty] = useState("10");
  const [limit, setLimit] = useState("");
  const [tab, setTab] = useState<Tab>("positions");
  // Orders with severe estimated slippage need a second click. `armed` holds the exact order
  // parameters that were armed, so editing anything disarms it; it also expires on its own.
  const [armed, setArmed] = useState<string | null>(null);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(null), 6000);
    return () => clearTimeout(t);
  }, [armed]);
  // Changing anything about the order disarms it, even if you later change it back.
  useEffect(() => {
    setArmed(null);
  }, [sym, side, type, qty, limit]);
  const [log, setLog] = useState<{ t: number; msg: string; err?: boolean }[]>([]);
  const [cmd, setCmd] = useState("");
  const [paused, setPaused] = useState(false);
  const history = useRef<string[]>([]);
  const histIdx = useRef(-1);

  const say = useCallback((msg: string, err = false) => {
    setLog((l) => [{ t: Date.now(), msg, err }, ...l].slice(0, 60));
  }, []);

  // Persist the paper account whenever it changes (cheap signature check, so safe to call often).
  const sourceRef = useRef<SourceKey | null>(null);
  const lastSaved = useRef("");
  const persist = useCallback(() => {
    const a = account.current;
    const src = sourceRef.current;
    if (!a || !src) return;
    const sig = a.signature();
    if (sig === lastSaved.current) return;
    if (saveAccount(src, a)) lastSaved.current = sig;
  }, []);

  // Fee schedule: a user setting, stored apart from the account. The ref lets account (re)creation
  // paths pick up the current rates without being re-created on every change.
  const [feeCfg, setFeeCfg] = useState<FeeConfig>(DEFAULT_FEE_CONFIG);
  const feeCfgRef = useRef<FeeConfig>(DEFAULT_FEE_CONFIG);
  const [feeOpen, setFeeOpen] = useState(false);
  const feeBox = useRef<HTMLDivElement>(null);
  const withRates = useCallback((acc: Account): Account => {
    acc.rates = ratesFor(feeCfgRef.current);
    return acc;
  }, []);
  const updateFees = useCallback(
    (next: FeeConfig) => {
      feeCfgRef.current = next;
      setFeeCfg(next);
      saveFeeConfig(next);
      if (account.current) account.current.rates = ratesFor(next);
      const r = ratesFor(next);
      say(`Fee schedule: ${feeLabel(next)}, maker ${fmtRate(r.maker)} / taker ${fmtRate(r.taker)} (applies to new fills).`);
      setTick((t) => t + 1);
    },
    [say]
  );
  useEffect(() => {
    if (!feeOpen) return;
    const onDown = (e: MouseEvent) => {
      if (feeBox.current && !feeBox.current.contains(e.target as Node)) setFeeOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setFeeOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [feeOpen]);

  // ── Backup: export the paper account to a JSON file, or import one (with confirmation) ──
  const [backupOpen, setBackupOpen] = useState(false);
  const backupBox = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [importDlg, setImportDlg] = useState<ImportDlg>(null);

  const exportBackup = useCallback(() => {
    const a = account.current;
    const src = sourceRef.current;
    if (!a || !src) return;
    try {
      const now = new Date();
      const name = backupFilename(src, now);
      const blob = new Blob([JSON.stringify(buildBackup(src, a, now), null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      say(`Exported paper account to ${name} (${a.fills.length} fills, ${Object.keys(a.positions).length} positions, ${a.orders.length} working orders).`);
    } catch (e) {
      say(`Export failed: ${(e as Error).message}`, true);
    }
  }, [say]);

  const onImportFile = useCallback(async (file: File | undefined) => {
    const src = sourceRef.current;
    const mk = market.current;
    if (!file || !src || !mk) return;
    if (file.size > MAX_BACKUP_BYTES) return setImportDlg({ kind: "error", message: "That file is too large to be a paper-account backup." });
    let text: string;
    try {
      text = await file.text();
    } catch {
      return setImportDlg({ kind: "error", message: "Couldn't read that file." });
    }
    const res = parseBackup(text, src, new Set(mk.instruments.map((i) => i.sym)));
    setImportDlg(
      res.ok
        ? { kind: "confirm", account: res.account, dropped: res.dropped, summary: res.summary }
        : { kind: "error", message: res.error }
    );
  }, []);

  const applyImport = useCallback(() => {
    if (!importDlg || importDlg.kind !== "confirm") return;
    const { account: next, summary: s, dropped } = importDlg;
    account.current = withRates(next);
    lastSaved.current = ""; // force a write even if the signature happens to match
    persist();
    say(`Imported backup: ${s.fills} fills, ${s.positions} positions, ${s.orders} working orders, cash $${fmt(s.cash)}.`);
    if (dropped) say(`${dropped} position/order(s) in the backup were for symbols not in this feed and were dropped.`, true);
    setImportDlg(null);
    setTick((t) => t + 1);
  }, [importDlg, withRates, persist, say]);

  useEffect(() => {
    if (!backupOpen) return;
    const onDown = (e: MouseEvent) => {
      if (backupBox.current && !backupBox.current.contains(e.target as Node)) setBackupOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setBackupOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [backupOpen]);

  useEffect(() => {
    if (!importDlg) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setImportDlg(null);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [importDlg]);

  // Flush on tab close, and pick up changes made in another tab.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      const src = sourceRef.current;
      const mk = market.current;
      if (!src || !mk || e.key !== storageKey(src) || !e.newValue) return;
      const res = parseAccount(e.newValue, new Set(mk.instruments.map((i) => i.sym)));
      if (!res) return;
      account.current = withRates(res.account);
      lastSaved.current = res.account.signature();
      setTick((t) => t + 1);
    };
    window.addEventListener("pagehide", persist);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("pagehide", persist);
      window.removeEventListener("storage", onStorage);
    };
  }, [persist, withRates]);

  // init on client only: try Binance public data, fall back to simulation
  useEffect(() => {
    let cancelled = false;
    let feed: Feed | null = null;
    (async () => {
      try {
        const b = new BinanceMarket();
        await b.init();
        if (cancelled) return b.dispose();
        feed = b;
        setQty("0.01");
        setSource("binance");
        say("Connected to Binance public market data. Orders are paper-traded locally. Type `help` for commands.");
      } catch (e) {
        if (cancelled) return;
        feed = new Market();
        setSource("sim");
        say(`Could not reach Binance (${(e as Error).message}). Using simulated prices instead.`, true);
      }
      const src: SourceKey = feed instanceof BinanceMarket ? "binance" : "sim";
      const restored = loadAccount(src, new Set(feed.instruments.map((i) => i.sym)));
      const cfg = loadFeeConfig();
      feeCfgRef.current = cfg;
      setFeeCfg(cfg);
      account.current = withRates(restored?.account ?? new Account());
      sourceRef.current = src;
      lastSaved.current = restored ? restored.account.signature() : "";
      if (restored) {
        const r = restored.account;
        say(
          `Restored your paper account: ${r.fills.length} fills, ${Object.keys(r.positions).length} positions, ${r.orders.length} working orders. Type \`reset\` to start over.`
        );
        if (restored.dropped) say(`${restored.dropped} saved position/order(s) were for symbols not in this feed and were dropped.`, true);
      }
      market.current = feed;
      setSym(feed.instruments[0].sym);
      setTick(1);
    })();
    return () => {
      cancelled = true;
      feed?.dispose();
    };
  }, [say, withRates]);

  useEffect(() => {
    if (paused) return;
    const id = setInterval(() => {
      const m = market.current;
      const a = account.current;
      if (!m || !a) return;
      m.tick();
      const lastId = a.fills[0]?.id ?? 0;
      a.match(m);
      for (const f of a.fills.filter((x) => x.id > lastId).reverse()) say(`Filled #${f.orderId}: ${describeFill(f)}`);
      persist();
      setTick((t) => t + 1);
    }, TICK_MS);
    return () => clearInterval(id);
  }, [paused, say, persist]);

  const m = market.current;
  const a = account.current;

  const place = useCallback(
    (s: string, sd: Side, ty: OrderType, q: number, lim?: number) => {
      const mk = market.current!;
      const ac = account.current!;
      const lastId = ac.fills[0]?.id ?? 0;
      const knownOrders = new Set(ac.orders.map((o) => o.id));
      const err = ac.submit(mk, { sym: s, side: sd, type: ty, qty: q, limit: lim });
      if (err) return say(err, true);
      for (const f of ac.fills.filter((x) => x.id > lastId).reverse()) say(`Filled: ${describeFill(f)}`);
      const rest = ac.orders.find((o) => !knownOrders.has(o.id));
      if (rest) say(`Working #${rest.id}: ${sd} ${fmtQty(rest.qty)} ${s} LMT @ ${fmt(lim!, dpFor(s))}`);
      persist();
      setTick((t) => t + 1);
    },
    [say, persist]
  );

  const runCommand = (raw: string) => {
    const line = raw.trim();
    if (!line) return;
    history.current.unshift(line);
    histIdx.current = -1;
    say(`> ${line}`);
    const [c, ...args] = line.split(/\s+/);
    const cmdName = c.toLowerCase();
    const mk = market.current!;
    const ac = account.current!;
    const known = (s?: string) => (s && mk.price[s.toUpperCase()] ? s.toUpperCase() : null);

    if (cmdName === "buy" || cmdName === "sell") {
      // a trailing "!" (or "force") confirms an order flagged for high slippage
      const rest = [...args];
      const force = rest.length > 1 && /^(!|force)$/i.test(rest[rest.length - 1]);
      if (force) rest.pop();
      const s = known(rest[0]);
      const q = parseFloat(rest[1]);
      if (!s) return say(`Usage: ${cmdName} SYMBOL QTY [LIMIT] [!]  (symbols: ${mk.instruments.map((i) => i.sym).join(", ")})`, true);
      if (!(q > 0)) return say("Quantity must be a positive number", true);
      const lim = rest[2] ? parseFloat(rest[2].replace("@", "")) : undefined;
      if (rest[2] && !(lim! > 0)) return say("Limit price must be a positive number", true);
      setSym(s);
      const sd: Side = cmdName === "buy" ? "BUY" : "SELL";
      const pre = estimateSlippage(mk, s, sd, q, lim);
      if (pre && pre.severity === "severe" && !force) {
        say(`Not sent. High price impact: ${slippageLine(pre)}.`, true);
        return say(`Re-send with "!" to confirm: ${cmdName} ${s} ${q}${lim ? " " + lim : ""} !`, true);
      }
      return place(s, sd, lim ? "LMT" : "MKT", q, lim);
    }
    if (cmdName === "flat" || cmdName === "close") {
      const s = known(args[0]);
      if (!s) return say("Usage: flat SYMBOL", true);
      const p = ac.positions[s];
      if (!p) return say(`No position in ${s}`, true);
      return place(s, "SELL", "MKT", p.qty);
    }
    if (cmdName === "cancel") {
      const target = args[0] === "all" ? "all" : parseInt(args[0], 10);
      if (target !== "all" && !Number.isFinite(target)) return say("Usage: cancel ORDER_ID | cancel all", true);
      const n = ac.cancel(target);
      persist();
      setTick((t) => t + 1);
      return say(n ? `Cancelled ${n} order(s)` : "No matching order", !n);
    }
    if (cmdName === "chart" || cmdName === "go") {
      const s = known(args[0]);
      if (!s) return say("Usage: chart SYMBOL", true);
      return setSym(s);
    }
    if (cmdName === "pause") return setPaused(true);
    if (cmdName === "resume") return setPaused(false);
    if (cmdName === "reset") {
      account.current = withRates(new Account());
      persist();
      setTick((t) => t + 1);
      return say("Account reset to $" + fmt(START_CASH, 0));
    }
    if (cmdName === "clear") return setLog([]);
    if (cmdName === "export") return exportBackup();
    if (cmdName === "import") return fileInput.current?.click();
    if (cmdName === "help") {
      return [
        "buy|sell SYM QTY [LIMIT] [!]   e.g. buy BTCUSDT 0.01   |  sell ETHUSDT 1 2600   (! confirms high slippage)",
        "flat SYM                   close the whole position at market",
        "cancel ID | cancel all     cancel working orders",
        "chart SYM                  switch chart/ticket symbol",
        "pause | resume | reset | clear",
        "export | import            back up / restore the paper account as a JSON file",
      ].forEach((l) => say(l));
    }
    say(`Unknown command: ${cmdName}. Type help.`, true);
  };

  const equity = m && a ? a.equity(m) : START_CASH;
  const unreal = m && a ? a.unrealized(m) : 0;
  const total = equity - START_CASH;

  const refPx = useMemo(() => (m ? (side === "BUY" ? m.ask(sym) : m.bid(sym)) : 0), [m, side, sym, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!m || !a) {
    return <div className="flex h-screen items-center justify-center bg-[#0b0e14] font-mono text-slate-500">Loading terminal…</div>;
  }

  const dp = dpFor(sym);
  const pnlColor = (v: number) => (v > 0 ? "text-[#26d07c]" : v < 0 ? "text-[#ff5b6e]" : "text-slate-400");
  const sign = (v: number, d = 2) => (v > 0 ? "+" : "") + fmt(v, d);
  const qNum = parseFloat(qty);
  const limNum = parseFloat(limit);
  const est =
    qNum > 0 && !(type === "LMT" && !(limNum > 0))
      ? sweep(m, sym, side, qNum, type === "LMT" ? limNum : undefined)
      : null;
  const estNotional = est ? est.cost + (type === "LMT" ? (qNum - est.qty) * limNum : 0) : 0;
  // marketable part pays taker; any remainder would rest and pay maker
  const estFee = est ? est.cost * a.rates.taker + (estNotional - est.cost) * a.rates.maker : 0;
  const slip =
    qNum > 0 && !(type === "LMT" && !(limNum > 0))
      ? estimateSlippage(m, sym, side, qNum, type === "LMT" ? limNum : undefined)
      : null;
  const orderKey = `${sym}|${side}|${type}|${qty}|${type === "LMT" ? limit : ""}`;
  const isArmed = armed === orderKey;
  const needsConfirm = slip?.severity === "severe";
  const isBlocked = slip?.severity === "blocked" && type === "MKT";
  const slipTone =
    slip?.severity === "severe" || slip?.severity === "blocked"
      ? "border-[#ff5b6e]/50 bg-[#ff5b6e]/10 text-[#ff8a98]"
      : "border-amber-400/40 bg-amber-400/10 text-amber-300";
  const slipTitle =
    slip?.severity === "blocked"
      ? "Not enough visible liquidity"
      : slip?.severity === "severe"
        ? "High price impact"
        : "Noticeable price impact";

  return (
    <div className="flex min-h-screen flex-col bg-[#0b0e14] font-mono text-sm text-slate-200 lg:h-screen lg:overflow-hidden">
      {/* Top bar */}
      <header className="flex flex-wrap items-center gap-x-6 gap-y-1 border-b border-white/10 bg-[#10141c] px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="text-base font-bold tracking-wider text-[#26d07c]">▲ TERMINAL</span>
          <span className="rounded bg-amber-400/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300">
            {source === "binance" ? "BINANCE LIVE DATA · PAPER ORDERS" : "PAPER · SIMULATED DATA"}
          </span>
        </div>
        <Stat label="Equity" value={`$${fmt(equity)}`} />
        <Stat label="Cash" value={`$${fmt(a.cash)}`} />
        <Stat label="Unrealized" value={sign(unreal)} cls={pnlColor(unreal)} />
        <Stat label="Realized (net)" value={sign(a.realized)} cls={pnlColor(a.realized)} />
        <Stat label="Fees paid" value={`$${fmt(a.fees)}`} />
        <Stat label="Total P&L" value={`${sign(total)} (${sign((total / START_CASH) * 100)}%)`} cls={pnlColor(total)} />
        <div className="ml-auto flex items-center gap-2">
          <div ref={feeBox} className="relative">
            <button
              onClick={() => {
                setFeeOpen((o) => !o);
                setBackupOpen(false);
              }}
              aria-expanded={feeOpen}
              aria-haspopup="dialog"
              className="rounded border border-white/15 px-2 py-1 text-xs hover:bg-white/5"
            >
              Fees: {feeLabel(feeCfg)} · {fmtRate(a.rates.maker)} / {fmtRate(a.rates.taker)}
            </button>
            {feeOpen && (
              <div
                role="dialog"
                aria-label="Fee tier"
                className="absolute right-0 top-full z-30 mt-1 w-72 space-y-3 rounded border border-white/15 bg-[#10141c] p-3 text-xs shadow-xl"
              >
                <label className="block text-slate-400">
                  Fee tier
                  <select
                    value={feeCfg.tier}
                    onChange={(e) => updateFees({ ...feeCfg, tier: e.target.value })}
                    className="mt-1 w-full rounded border border-white/15 bg-[#0b0e14] px-2 py-1.5 text-slate-100 outline-none focus:border-white/40"
                  >
                    {FEE_TIERS.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label} · maker {fmtRate(t.maker / 100)} / taker {fmtRate(t.taker / 100)}
                      </option>
                    ))}
                    <option value="custom">Custom…</option>
                  </select>
                </label>
                {feeCfg.tier === "custom" ? (
                  <div className="grid grid-cols-2 gap-2">
                    {(["maker", "taker"] as const).map((k) => (
                      <label key={k} className="block text-slate-400">
                        {k === "maker" ? "Maker %" : "Taker %"}
                        <input
                          type="number"
                          min={0}
                          max={MAX_CUSTOM_PCT}
                          step={0.001}
                          value={feeCfg.custom[k]}
                          onChange={(e) => {
                            const v = parseFloat(e.target.value);
                            updateFees({ ...feeCfg, custom: { ...feeCfg.custom, [k]: Number.isFinite(v) ? v : 0 } });
                          }}
                          className="mt-1 w-full rounded border border-white/15 bg-[#0b0e14] px-2 py-1.5 text-slate-100 outline-none focus:border-white/40"
                        />
                      </label>
                    ))}
                  </div>
                ) : (
                  <label className="flex items-center gap-2 text-slate-300">
                    <input
                      type="checkbox"
                      checked={feeCfg.bnb}
                      onChange={(e) => updateFees({ ...feeCfg, bnb: e.target.checked })}
                    />
                    Pay fees in BNB (25% discount)
                  </label>
                )}
                <div className="flex justify-between text-slate-400">
                  <span>Effective maker / taker</span>
                  <span className="text-slate-100">
                    {fmtRate(a.rates.maker)} / {fmtRate(a.rates.taker)}
                  </span>
                </div>
                <p className="text-[10px] leading-snug text-slate-500">
                  Applies to new fills only; past fills keep the fee they were charged. Tier rates are approximate and
                  Binance changes them, so check the current schedule or use Custom.
                </p>
              </div>
            )}
          </div>
          <div ref={backupBox} className="relative">
            <button
              onClick={() => {
                setBackupOpen((o) => !o);
                setFeeOpen(false);
              }}
              aria-expanded={backupOpen}
              aria-haspopup="menu"
              className="rounded border border-white/15 px-2 py-1 text-xs hover:bg-white/5"
            >
              Backup
            </button>
            {backupOpen && (
              <div
                role="menu"
                className="absolute right-0 top-full z-30 mt-1 w-56 overflow-hidden rounded border border-white/15 bg-[#10141c] py-1 text-xs shadow-xl"
              >
                <button
                  role="menuitem"
                  onClick={() => {
                    setBackupOpen(false);
                    exportBackup();
                  }}
                  className="block w-full px-3 py-2 text-left hover:bg-white/5"
                >
                  Export account (.json)
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setBackupOpen(false);
                    fileInput.current?.click();
                  }}
                  className="block w-full px-3 py-2 text-left hover:bg-white/5"
                >
                  Import account…
                </button>
              </div>
            )}
            <input
              ref={fileInput}
              type="file"
              accept="application/json,.json"
              aria-label="Import paper account file"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = ""; // let the same file be chosen again later
                void onImportFile(f);
              }}
            />
          </div>
          <button
            onClick={() => setPaused((p) => !p)}
            className="rounded border border-white/15 px-2 py-1 text-xs hover:bg-white/5"
          >
            {paused ? "▶ Resume feed" : "⏸ Pause feed"}
          </button>
        </div>
      </header>

      {importDlg && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onMouseDown={(e) => e.target === e.currentTarget && setImportDlg(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={importDlg.kind === "confirm" ? "Import paper account" : "Import failed"}
            className="w-full max-w-md space-y-3 rounded border border-white/15 bg-[#10141c] p-4 text-xs shadow-2xl"
          >
            {importDlg.kind === "error" ? (
              <>
                <h2 className="text-sm font-bold text-[#ff5b6e]">Couldn&apos;t import</h2>
                <p className="text-slate-300">{importDlg.message}</p>
                <div className="flex justify-end">
                  <button
                    autoFocus
                    onClick={() => setImportDlg(null)}
                    className="rounded border border-white/20 px-3 py-1.5 hover:bg-white/5"
                  >
                    Close
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2 className="text-sm font-bold">Replace your paper account?</h2>
                <p className="text-slate-400">
                  Backup from{" "}
                  <span className="text-slate-200">
                    {Number.isNaN(Date.parse(importDlg.summary.exportedAt))
                      ? "an unknown date"
                      : new Date(importDlg.summary.exportedAt).toLocaleString()}
                  </span>{" "}
                  ({sourceName(importDlg.summary.source)} feed).
                </p>
                <table className="w-full">
                  <thead className="text-slate-500">
                    <tr>
                      <th className="py-1 text-left font-normal"></th>
                      <th className="py-1 text-right font-normal">Current</th>
                      <th className="py-1 text-right font-normal">Backup</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(
                      [
                        ["Equity", `$${fmt(a.equity(m))}`, `$${fmt(importDlg.account.equity(m))}`],
                        ["Cash", `$${fmt(a.cash)}`, `$${fmt(importDlg.summary.cash)}`],
                        ["Positions", String(Object.keys(a.positions).length), String(importDlg.summary.positions)],
                        ["Working orders", String(a.orders.length), String(importDlg.summary.orders)],
                        ["Fills", String(a.fills.length), String(importDlg.summary.fills)],
                        ["Realized (net)", sign(a.realized), sign(importDlg.summary.realized)],
                        ["Fees paid", `$${fmt(a.fees)}`, `$${fmt(importDlg.summary.fees)}`],
                      ] as [string, string, string][]
                    ).map(([k, cur, bak]) => (
                      <tr key={k} className="border-t border-white/5">
                        <td className="py-1 text-slate-400">{k}</td>
                        <td className="py-1 text-right">{cur}</td>
                        <td className="py-1 text-right text-slate-100">{bak}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {importDlg.dropped > 0 && (
                  <p className="text-amber-300">
                    {importDlg.dropped} position/order(s) in the file use symbols this feed doesn&apos;t have and will be dropped.
                  </p>
                )}
                <p className="text-slate-500">This replaces your current account and can&apos;t be undone. Equity is at current prices.</p>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <button onClick={exportBackup} className="mr-auto text-slate-400 underline hover:text-slate-200">
                    Back up current first
                  </button>
                  <button
                    autoFocus
                    onClick={() => setImportDlg(null)}
                    className="rounded border border-white/20 px-3 py-1.5 hover:bg-white/5"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={applyImport}
                    className="rounded bg-[#ff5b6e] px-3 py-1.5 font-bold text-[#0b0e14] hover:opacity-90"
                  >
                    Replace account
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <div className="grid flex-1 grid-cols-1 gap-px bg-white/10 lg:min-h-0 lg:grid-cols-[220px_minmax(0,1fr)_280px]">
        {/* Watchlist */}
        <aside className="bg-[#0b0e14] lg:overflow-y-auto">
          <Panel title="Watchlist" />
          {m.instruments.map((i) => {
            const ch = m.changePct(i.sym);
            return (
              <button
                key={i.sym}
                onClick={() => setSym(i.sym)}
                className={`flex w-full items-center justify-between px-3 py-2 text-left hover:bg-white/5 ${
                  sym === i.sym ? "bg-white/[0.07]" : ""
                }`}
              >
                <div>
                  <div className="font-semibold">{i.sym}</div>
                  <div className="text-[10px] text-slate-500">{i.name}</div>
                </div>
                <div className="text-right">
                  <div>{fmt(m.price[i.sym], i.dp)}</div>
                  <div className={`text-[11px] ${pnlColor(ch)}`}>{sign(ch)}%</div>
                </div>
              </button>
            );
          })}
        </aside>

        {/* Center: chart + blotter + command line */}
        <main className="flex min-w-0 flex-col bg-[#0b0e14] lg:min-h-0">
          <div className="flex items-baseline gap-4 border-b border-white/10 px-4 py-2">
            <span className="text-lg font-bold">{sym}</span>
            <span className="text-lg">{fmt(m.price[sym], dp)}</span>
            <span className={pnlColor(m.changePct(sym))}>{sign(m.changePct(sym))}%</span>
            <span className="ml-auto text-xs text-slate-500">
              bid {fmt(m.bid(sym), dp)} · ask {fmt(m.ask(sym), dp)}
            </span>
          </div>
          <div className="h-[320px] lg:h-auto lg:min-h-[200px] lg:flex-[3]">
            <Chart market={m} sym={sym} />
          </div>

          <div className="flex border-y border-white/10 bg-[#10141c] text-xs">
            {(["positions", "orders", "fills"] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-4 py-2 uppercase tracking-wider ${
                  tab === t ? "border-b-2 border-[#26d07c] text-white" : "text-slate-500 hover:text-slate-300"
                }`}
              >
                {t}
                {t === "orders" && a.orders.length > 0 ? ` (${a.orders.length})` : ""}
              </button>
            ))}
          </div>
          <div className="h-48 overflow-auto lg:h-auto lg:flex-[2]">
            {tab === "positions" && (
              <Table
                head={["Symbol", "Qty", "Avg", "Last", "Mkt value", "Unrl P&L", ""]}
                empty="No open positions"
                rows={Object.entries(a.positions).map(([s, p]) => {
                  const d = dpFor(s);
                  const u = p.qty * (m.price[s] - p.avg);
                  return [
                    s,
                    fmtQty(p.qty),
                    fmt(p.avg, d),
                    fmt(m.price[s], d),
                    fmt(p.qty * m.price[s]),
                    <span key="u" className={pnlColor(u)}>
                      {sign(u)} ({sign((m.price[s] / p.avg - 1) * 100)}%)
                    </span>,
                    <button key="x" onClick={() => runCommand(`flat ${s}`)} className="text-xs text-[#ff5b6e] hover:underline">
                      close
                    </button>,
                  ];
                })}
              />
            )}
            {tab === "orders" && (
              <Table
                head={["ID", "Symbol", "Side", "Type", "Qty", "Limit", ""]}
                empty="No working orders"
                rows={a.orders.map((o) => [
                  `#${o.id}`,
                  o.sym,
                  <span key="s" style={{ color: o.side === "BUY" ? UP : DOWN }}>{o.side}</span>,
                  o.type,
                  fmtQty(o.qty),
                  fmt(o.limit!, dpFor(o.sym)),
                  <button key="x" onClick={() => runCommand(`cancel ${o.id}`)} className="text-xs text-[#ff5b6e] hover:underline">
                    cancel
                  </button>,
                ])}
              />
            )}
            {tab === "fills" && (
              <Table
                head={["Time", "Symbol", "Side", "Qty", "Avg price", "Lvls", "Slippage", "Fee", "Realized"]}
                empty="No fills yet"
                rows={a.fills.map((f) => [
                  new Date(f.ts).toLocaleTimeString(),
                  f.sym,
                  <span key="s" style={{ color: f.side === "BUY" ? UP : DOWN }}>{f.side}</span>,
                  fmtQty(f.qty),
                  fmt(f.price, dpFor(f.sym)),
                  f.levels,
                  fmt(f.slip, dpFor(f.sym)),
                  `${fmt(f.fee, 4)} ${f.role[0].toUpperCase()}`,
                  f.side === "SELL" ? <span key="p" className={pnlColor(f.pnl)}>{sign(f.pnl)}</span> : "—",
                ])}
              />
            )}
          </div>

          {/* Command line */}
          <div className="border-t border-white/10 bg-[#10141c]">
            <div className="h-24 overflow-y-auto px-3 py-1 text-xs flex flex-col-reverse">
              {log.map((l, i) => (
                <div key={i} className={l.err ? "text-[#ff5b6e]" : "text-slate-400"}>
                  <span className="text-slate-600">{new Date(l.t).toLocaleTimeString()} </span>
                  {l.msg}
                </div>
              ))}
            </div>
            <form
              className="flex items-center gap-2 border-t border-white/10 px-3 py-2"
              onSubmit={(e) => {
                e.preventDefault();
                runCommand(cmd);
                setCmd("");
              }}
            >
              <span className="text-[#26d07c]">❯</span>
              <input
                value={cmd}
                onChange={(e) => setCmd(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowUp" && history.current.length) {
                    e.preventDefault();
                    histIdx.current = Math.min(histIdx.current + 1, history.current.length - 1);
                    setCmd(history.current[histIdx.current]);
                  } else if (e.key === "ArrowDown") {
                    e.preventDefault();
                    histIdx.current = Math.max(histIdx.current - 1, -1);
                    setCmd(histIdx.current === -1 ? "" : history.current[histIdx.current]);
                  }
                }}
                placeholder="buy BTCUSDT 0.01   ·   sell ETHUSDT 1 2600   ·   help"
                spellCheck={false}
                autoComplete="off"
                className="flex-1 bg-transparent text-slate-100 outline-none placeholder:text-slate-600"
              />
            </form>
          </div>
        </main>

        {/* Right: ticket + book */}
        <aside className="bg-[#0b0e14] lg:overflow-y-auto">
          <Panel title={`Order ticket · ${sym}`} />
          <div className="space-y-3 p-3">
            <div className="grid grid-cols-2 gap-2">
              {(["BUY", "SELL"] as Side[]).map((s) => (
                <button
                  key={s}
                  onClick={() => setSide(s)}
                  className="rounded py-2 font-bold"
                  style={
                    side === s
                      ? { background: s === "BUY" ? UP : DOWN, color: "#0b0e14" }
                      : { background: "rgba(255,255,255,0.05)", color: "#94a3b8" }
                  }
                >
                  {s}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              {(["MKT", "LMT"] as OrderType[]).map((t) => (
                <button
                  key={t}
                  onClick={() => {
                    setType(t);
                    if (t === "LMT" && !limit) setLimit(refPx.toFixed(dp));
                  }}
                  className={`rounded border py-1.5 ${
                    type === t ? "border-white/40 text-white" : "border-white/10 text-slate-500"
                  }`}
                >
                  {t === "MKT" ? "Market" : "Limit"}
                </button>
              ))}
            </div>
            <label className="block text-xs text-slate-400">
              Quantity
              <input
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                inputMode="decimal"
                className="mt-1 w-full rounded border border-white/15 bg-[#10141c] px-2 py-1.5 text-sm text-slate-100 outline-none focus:border-white/40"
              />
            </label>
            {type === "LMT" && (
              <label className="block text-xs text-slate-400">
                Limit price
                <input
                  value={limit}
                  onChange={(e) => setLimit(e.target.value)}
                  inputMode="decimal"
                  className="mt-1 w-full rounded border border-white/15 bg-[#10141c] px-2 py-1.5 text-sm text-slate-100 outline-none focus:border-white/40"
                />
              </label>
            )}
            <div className="flex justify-between text-xs text-slate-400">
              <span>Est. {side === "BUY" ? "cost" : "proceeds"}</span>
              <span className="text-slate-200">${fmt(side === "BUY" ? estNotional + estFee : estNotional - estFee)}</span>
            </div>
            <div className="flex justify-between text-xs text-slate-400">
              <span>Fee ({fmtRate(a.rates.taker)})</span>
              <span className="text-slate-200">${fmt(estFee, 4)}</span>
            </div>
            {est && est.qty > 0 && (
              <div className="flex justify-between text-xs text-slate-400">
                <span>Avg fill · {est.levels} lvl{est.levels === 1 ? "" : "s"}</span>
                <span className="text-slate-200">{fmt(est.avg, dp)}</span>
              </div>
            )}
            {slip && slip.hasDepth && slip.filled > 0 && (
              <div className="flex justify-between text-xs text-slate-400">
                <span>Est. slippage</span>
                <span
                  className={
                    slip.severity === "severe"
                      ? "text-[#ff5b6e]"
                      : slip.severity === "warn"
                        ? "text-amber-300"
                        : "text-slate-200"
                  }
                >
                  {slip.slipBps.toFixed(1)} bps · ${fmt(slip.slipCost, 2)}
                </span>
              </div>
            )}
            {slip && (slip.severity === "warn" || slip.severity === "severe" || slip.severity === "blocked") && (
              <div role="alert" className={`rounded border px-2 py-1.5 text-[11px] leading-snug ${slipTone}`}>
                <div className="font-semibold">{slipTitle}</div>
                <ul className="mt-0.5 list-disc space-y-0.5 pl-4">
                  {slip.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </div>
            )}
            {slip && slip.notes.length > 0 && (
              <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-slate-500">
                {slip.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            )}
            <button
              disabled={isBlocked}
              onClick={() => {
                if (needsConfirm && !isArmed) return setArmed(orderKey);
                setArmed(null);
                place(sym, side, type, parseFloat(qty), type === "LMT" ? parseFloat(limit) : undefined);
              }}
              className="w-full rounded py-2.5 font-bold text-[#0b0e14] disabled:cursor-not-allowed disabled:opacity-40"
              style={{ background: isArmed ? "#f5a524" : side === "BUY" ? UP : DOWN }}
            >
              {isBlocked
                ? "Not enough liquidity"
                : isArmed
                  ? `Confirm ${side} ${qty} ${sym} · ~${slip!.slipBps.toFixed(0)} bps`
                  : `${side} ${qty || "0"} ${sym}${needsConfirm ? " ⚠" : ""}`}
            </button>
            {needsConfirm && (
              <div aria-live="polite" className="text-center text-[10px] text-slate-500">
                {isArmed
                  ? "Click again within 6s to send, or change the order to cancel."
                  : `Estimated impact is over ${SLIPPAGE_SEVERE_BPS} bps or the order takes most of the book. You'll be asked to confirm.`}
              </div>
            )}
          </div>
          <Panel
            title={
              m.depth?.(sym)
                ? `Order book · Binance live (top 8)${m.impactActive?.(sym) ? " · net of your fills" : ""}`
                : "Order book (illustrative depth)"
            }
          />
          <OrderBook market={m} sym={sym} tick={tick} />
        </aside>
      </div>
    </div>
  );
}

function Stat({ label, value, cls = "" }: { label: string; value: string; cls?: string }) {
  return (
    <div className="leading-tight">
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className={`text-sm font-semibold ${cls}`}>{value}</div>
    </div>
  );
}

function Panel({ title }: { title: string }) {
  return (
    <div className="border-y border-white/10 bg-[#10141c] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-slate-500">
      {title}
    </div>
  );
}

function Table({ head, rows, empty }: { head: string[]; rows: React.ReactNode[][]; empty: string }) {
  if (!rows.length) return <div className="p-4 text-xs text-slate-600">{empty}</div>;
  return (
    <table className="w-full text-xs">
      <thead className="sticky top-0 bg-[#0b0e14] text-slate-500">
        <tr>
          {head.map((h, i) => (
            <th key={i} className="px-3 py-1.5 text-left font-normal">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-t border-white/5 hover:bg-white/[0.03]">
            {r.map((c, j) => (
              <td key={j} className="px-3 py-1.5">
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
