"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { BinanceMarket } from "@/lib/trading/binance";
import {
  buildGrid,
  buildSegments,
  heatColor,
  inflowFor,
  loadLiqPref,
  saveLiqPref,
  type LiqMode,
  type Segment,
} from "@/lib/trading/liquidations";
import {
  FIB_MAX_PER_SYMBOL,
  fibColor,
  fibLevels,
  levelPrice,
  loadFibExtensions,
  loadFibs,
  nearestHandle,
  newFibId,
  saveFibExtensions,
  saveFibs,
  snapTime,
  timeToIndex,
  type Fib,
  type FibPoint,
} from "@/lib/trading/fib";
import {
  STOCH_D_COLOR,
  STOCH_K_COLOR,
  STOCH_MAX_K,
  STOCH_MAX_SMOOTH,
  STOCH_MIN_K,
  STOCH_OVERBOUGHT,
  STOCH_OVERSOLD,
  loadStochConfig,
  saveStochConfig,
  stochLabel,
  stochastic,
  type StochConfig,
  RSI_COLOR,
  RSI_MAX_PERIOD,
  RSI_MIN_PERIOD,
  RSI_OVERBOUGHT,
  RSI_OVERSOLD,
  loadRsiConfig,
  rsiOf,
  saveRsiConfig,
  type RsiConfig,
  BB_COLOR,
  BB_FILL,
  BB_MAX_MULT,
  BB_MIN_MULT,
  MA_COLORS,
  MA_MAX_PERIOD,
  MA_MIN_PERIOD,
  bbLabel,
  bollingerOf,
  computeMovingAverages,
  loadBbConfig,
  saveBbConfig,
  type BbConfig,
  type Bands,
  loadMaConfig,
  maLabel,
  saveMaConfig,
  type MaSlot,
} from "@/lib/trading/indicators";
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
import {
  appendedSince,
  clampOffset,
  formatVolume,
  loadVolumePref,
  maxOffset,
  resolveCount,
  saveVolumePref,
  windowStart,
  zoomAt,
  type View,
} from "@/lib/trading/chartview";
import { formatAxisTime, formatFullTime, loadTimeframeId, saveTimeframeId } from "@/lib/trading/timeframes";
import { loadAccount, parseAccount, saveAccount, storageKey, type SourceKey } from "@/lib/trading/storage";
import {
  Account,
  Market,
  START_CASH,
  sweep,
  type Candle,
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

const AXIS_W = 72; // right-hand price axis
const PAD = 12; // top padding inside the plot
const UP_DIM = "rgba(38, 208, 124, 0.45)"; // volume bars: the candle colours, softened
const DOWN_DIM = "rgba(255, 91, 110, 0.45)";

function NumField({
  label,
  text,
  value,
  min,
  max,
  integer,
  onCommit,
}: {
  label: string;
  text: string;
  value: number;
  min: number;
  max: number;
  integer?: boolean;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const parse = (t: string) => {
    const v = Number(t);
    return t.trim() !== "" && Number.isFinite(v) && v >= min && v <= max && (!integer || Number.isInteger(v)) ? v : null;
  };
  return (
    <label className="flex items-center justify-between gap-2 py-0.5">
      <span className="text-slate-400">{text}</span>
      <input
        inputMode="decimal"
        aria-label={label}
        aria-invalid={parse(draft) === null}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          const v = parse(e.target.value);
          if (v !== null) onCommit(v);
        }}
        onBlur={() => setDraft(String(value))}
        className={`w-16 rounded border bg-[#0b0e14] px-1 py-0.5 text-right text-slate-200 ${parse(draft) === null ? "border-red-500" : "border-white/15"}`}
      />
    </label>
  );
}

function MaRow({ index, slot, onChange }: { index: number; slot: MaSlot; onChange: (s: MaSlot) => void }) {
  const [draft, setDraft] = useState(String(slot.period));
  useEffect(() => setDraft(String(slot.period)), [slot.period]);
  const n = Number(draft);
  const valid = draft.trim() !== "" && Number.isInteger(n) && n >= MA_MIN_PERIOD && n <= MA_MAX_PERIOD;
  const n1 = index + 1;
  return (
    <div className="flex items-center gap-2 py-0.5">
      <input
        type="checkbox"
        aria-label={`Show moving average ${n1}`}
        checked={slot.enabled}
        onChange={(e) => onChange({ ...slot, enabled: e.target.checked })}
      />
      <span className="inline-block h-0.5 w-3" style={{ background: MA_COLORS[index] }} />
      <select
        aria-label={`Moving average ${n1} type`}
        value={slot.type}
        onChange={(e) => onChange({ ...slot, type: e.target.value === "ema" ? "ema" : "sma" })}
        className="rounded border border-white/15 bg-[#0b0e14] px-1 py-0.5 text-slate-200"
      >
        <option value="sma">SMA</option>
        <option value="ema">EMA</option>
      </select>
      <input
        inputMode="numeric"
        aria-label={`Moving average ${n1} period`}
        aria-invalid={!valid}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          const v = Number(e.target.value);
          if (e.target.value.trim() !== "" && Number.isInteger(v) && v >= MA_MIN_PERIOD && v <= MA_MAX_PERIOD) onChange({ ...slot, period: v });
        }}
        onBlur={() => setDraft(String(slot.period))}
        className={`w-14 rounded border bg-[#0b0e14] px-1 py-0.5 text-right text-slate-200 ${valid ? "border-white/15" : "border-red-500"}`}
      />
    </div>
  );
}

function Chart({ market, sym, tf, loading }: { market: Feed; sym: string; tf: string; loading: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const mouse = useRef<{ x: number; y: number } | null>(null);
  // Viewport: how many candles are visible (zoom) and how far back from the newest the window sits.
  const view = useRef<View>({ count: null, offset: 0 });
  const lastT = useRef<number | null>(null); // newest candle time seen, to keep a scrolled-back window anchored
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const older = useRef({ busy: false, loading: false, retryAt: 0, done: new Set<string>() });
  const [scrolled, setScrolled] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const [volShown, setVolShown] = useState(loadVolumePref); // volume pane on/off (remembered)
  const volOn = useRef(volShown);
  const [maCfg, setMaCfg] = useState<MaSlot[]>(loadMaConfig); // moving averages (remembered)
  const maRef = useRef(maCfg);
  const [panel, setPanel] = useState<"ma" | "bb" | "rsi" | "stoch" | "fib" | null>(null); // which indicator popover is open
  const [bbCfg, setBbCfg] = useState<BbConfig>(loadBbConfig); // Bollinger Bands (remembered)
  const bbRef = useRef(bbCfg);
  const bbCache = useRef<{ key: string; bands: Bands } | null>(null);
  const [rsiCfg, setRsiCfg] = useState<RsiConfig>(loadRsiConfig); // RSI pane (remembered)
  const rsiRef = useRef(rsiCfg);
  const [stochCfg, setStochCfg] = useState<StochConfig>(loadStochConfig); // Stochastic pane (remembered)
  const stochRef = useRef(stochCfg);
  // Fibonacci retracements (per symbol, remembered): placed with two clicks, anchors live in (time, price)
  const [fibs, setFibs] = useState<Fib[]>([]);
  const fibsRef = useRef<Fib[]>([]);
  const [fibExt, setFibExt] = useState(loadFibExtensions);
  const fibExtRef = useRef(fibExt);
  const [fibStep, setFibStep] = useState<0 | 1 | 2>(0); // 0 idle, 1 waiting for the first point, 2 for the second
  const fibStepRef = useRef<0 | 1 | 2>(0);
  const pendingA = useRef<FibPoint | null>(null);
  const fibDrag = useRef<{ id: string; which: "a" | "b" } | null>(null);
  const lastFibAction = useRef(0);
  const geo = useRef<{ hi: number; lo: number; pad: number; priceBottom: number; start: number; step: number; plotW: number; all: Candle[]; tfMs: number } | null>(null);
  // estimated liquidation heatmap (remembered); the segment model is cached per data set, the grid per view
  const [liqShown, setLiqShown] = useState(loadLiqPref);
  const liqOn = useRef(liqShown);
  const liqCache = useRef<{ key: string; mode: LiqMode; segments: Segment[]; top: Segment[] } | null>(null);
  const stochCache = useRef<{ key: string; k: (number | null)[]; d: (number | null)[] } | null>(null);
  const rsiCache = useRef<{ key: string; values: (number | null)[] } | null>(null);
  const maCache = useRef<{ key: string; series: ((number | null)[] | null)[] } | null>(null);
  const controls = useRef<HTMLDivElement>(null);

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
    const axisW = AXIS_W;
    const pad = PAD;
    const plotW = w - axisW - pad;
    const plotH = h - 24;
    const tfm = market.timeframes.find((x) => x.id === tf);
    const tfMs = tfm?.ms ?? 60_000;
    const all = market.candlesFor(sym, tf);
    ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textBaseline = "middle";
    if (all.length === 0) {
      ctx.fillStyle = "#7d8799";
      ctx.textAlign = "center";
      ctx.fillText(loading ? `Loading ${tfm?.label ?? tf} candles…` : "No candle data", plotW / 2, plotH / 2);
      ctx.textAlign = "left";
      return;
    }

    // ── viewport ──
    const v = view.current;
    const newest = all[all.length - 1].t;
    if (lastT.current !== null && v.offset > 0) {
      // while scrolled back, new candles must not drag the window along: stay anchored in time
      const added = appendedSince(all, lastT.current);
      if (added > 0) v.offset += added;
    }
    lastT.current = newest;
    const count = resolveCount(v, plotW);
    v.offset = clampOffset(v.offset, count, all.length);
    setScrolled(v.offset > 0.5);
    const start = windowStart(all.length, v.offset, count); // float index of the left edge (may be negative)
    const first = Math.max(0, Math.floor(start));
    const data = all.slice(first, Math.min(all.length, Math.ceil(start + count)));
    const step = plotW / count;
    const xOf = (idx: number) => (idx - start + 0.5) * step;
    cv.dataset.offset = v.offset.toFixed(2);
    cv.dataset.count = String(count);
    cv.dataset.loaded = String(all.length);
    cv.dataset.start = start.toFixed(2);

    // moving averages run over everything loaded (so they are already warm at the left edge of the window)
    const cfg = maRef.current;
    const maKey = `${sym}|${tf}|${all.length}|${all[0].t}|${newest}|${all[all.length - 1].c}|${JSON.stringify(cfg)}`;
    if (maCache.current?.key !== maKey) maCache.current = { key: maKey, series: computeMovingAverages(all, cfg) };
    const maSeries = maCache.current.series;
    const bb = bbRef.current;
    const rcfg = rsiRef.current;
    let rsiVals: (number | null)[] | null = null;
    if (rcfg.enabled) {
      const rKey = `${sym}|${tf}|${all.length}|${all[0].t}|${newest}|${all[all.length - 1].c}|${rcfg.period}`;
      if (rsiCache.current?.key !== rKey) rsiCache.current = { key: rKey, values: rsiOf(all, rcfg.period) };
      rsiVals = rsiCache.current.values;
    }
    const scfg = stochRef.current;
    let stochVals: { k: (number | null)[]; d: (number | null)[] } | null = null;
    if (scfg.enabled) {
      const sKey = `${sym}|${tf}|${all.length}|${all[0].t}|${newest}|${all[all.length - 1].c}|${all[all.length - 1].h}|${all[all.length - 1].l}|${scfg.k},${scfg.smooth},${scfg.d}`;
      if (stochCache.current?.key !== sKey) {
        const r = stochastic(all, scfg.k, scfg.smooth, scfg.d);
        stochCache.current = { key: sKey, k: r.k, d: r.d };
      }
      stochVals = stochCache.current;
    }
    const fm = mouse.current;
    const focusHover = fm && fm.x < plotW && fm.y < plotH ? Math.floor(fm.x / step + start) : -1;
    const focusAt = focusHover >= 0 && focusHover < all.length ? focusHover : Math.min(all.length, Math.ceil(start + count)) - 1;
    let bands: Bands | null = null;
    if (bb.enabled) {
      const bbKey = `${sym}|${tf}|${all.length}|${all[0].t}|${newest}|${all[all.length - 1].c}|${bb.period}|${bb.mult}`;
      if (bbCache.current?.key !== bbKey) bbCache.current = { key: bbKey, bands: bollingerOf(all, bb) };
      bands = bbCache.current.bands;
    }

    // ── panes: price on top, volume underneath (only when the visible candles carry volume) ──
    const hasVol = volOn.current && data.some((c) => c.v !== undefined);
    const volH = hasVol ? Math.min(90, Math.max(36, Math.round(plotH * 0.18))) : 0;
    const volTop = plotH - (hasVol ? volH + 6 : 0); // where the volume pane's block starts
    // oscillator panes sit between the price chart and the volume bars: price | RSI | Stochastic | volume
    const hasRsi = rsiRef.current.enabled;
    const hasStoch = stochRef.current.enabled;
    const nOsc = (hasRsi ? 1 : 0) + (hasStoch ? 1 : 0);
    let oscH = nOsc ? Math.min(90, Math.max(44, Math.round(plotH * 0.16))) : 0;
    if (nOsc) oscH = Math.max(30, Math.min(oscH, Math.floor((volTop - 120) / nOsc) - 6)); // keep the price chart usable
    const rsiH = hasRsi ? oscH : 0;
    const stochH = hasStoch ? oscH : 0;
    const stochBlockTop = volTop - (hasStoch ? stochH + 6 : 0);
    const priceBottom = stochBlockTop - (hasRsi ? rsiH + 6 : 0); // top of the RSI block
    const rsiTop = priceBottom + 12; // headroom for the pane label
    const rsiBottom = stochBlockTop - 3;
    const rsiY = (v: number) => rsiTop + ((100 - v) / 100) * (rsiBottom - rsiTop);
    const stochTop = stochBlockTop + 12;
    const stochBottom = volTop - 3;
    const stochY = (v: number) => stochTop + ((100 - v) / 100) * (stochBottom - stochTop);
    const volBottom = plotH;
    const volUsable = Math.max(1, volH - 14); // headroom for the pane label
    let maxV = 0;
    if (hasVol) for (const c of data) maxV = Math.max(maxV, c.v ?? 0);
    maxV = Math.max(maxV, 1e-12);
    cv.dataset.vol = hasVol ? "1" : "0";
    cv.dataset.volh = String(volH);
    cv.dataset.maxv = hasVol ? String(maxV) : "";
    cv.dataset.rsih = String(rsiH);
    cv.dataset.stochh = String(stochH);
    cv.dataset.priceh = String(priceBottom);

    // near the oldest loaded candle: fetch another page of history (once at a time, retry after a pause)
    if (start < 5) {
      const key = `${sym}|${tf}`;
      const o = older.current;
      if (!o.done.has(key) && !o.busy && Date.now() >= o.retryAt) {
        o.busy = o.loading = true;
        market
          .loadOlder(sym, tf)
          .then((r) => {
            if (r.done) o.done.add(key);
          })
          .catch(() => {
            o.retryAt = Date.now() + 5000;
          })
          .finally(() => {
            o.busy = o.loading = false;
          });
      }
    }

    let lo = Infinity;
    let hi = -Infinity;
    for (const c of data) {
      lo = Math.min(lo, c.l);
      hi = Math.max(hi, c.h);
    }
    const margin = (hi - lo) * 0.08 || hi * 0.001;
    lo -= margin;
    hi += margin;
    const y = (p: number) => pad + ((hi - p) / (hi - lo)) * (priceBottom - pad);
    geo.current = { hi, lo, pad, priceBottom, start, step, plotW, all, tfMs };
    cv.dataset.hi = String(hi);
    cv.dataset.lo = String(lo);

    // last price geometry (the label is pinned to the plot edge when the price is off screen)
    const lastC = all[all.length - 1];
    const lc = lastC.c >= lastC.o ? UP : DOWN;
    const rawY = y(lastC.c);
    const ly = Math.min(Math.max(Math.round(rawY), pad + 9), priceBottom - 9) + 0.5;

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
      if (Math.abs(yy - ly) > 12) ctx.fillText(fmt(p, dp), plotW + 8, yy); // leave room for the last-price label
    }

    // time axis: labels anchored to absolute candle index so they stay put as you pan or new candles arrive
    ctx.fillStyle = "#7d8799";
    ctx.textAlign = "center";
    const every = Math.max(1, Math.ceil(110 / step));
    data.forEach((c, k) => {
      const idx = first + k;
      if (idx % every !== 0) return;
      const x = xOf(idx);
      if (x < 30 || x > plotW - 30) return;
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, plotH);
      ctx.stroke();
      ctx.fillText(formatAxisTime(c.t, tfMs), x, plotH + 12);
    });
    ctx.textAlign = "left";

    // estimated liquidation heatmap, underneath the candles
    cv.dataset.liq = "";
    if (liqOn.current) {
      void market.loadOpenInterest?.(sym, tf); // cheap: refreshes at most once a minute, never throws
      const oi = market.openInterestFor?.(sym, tf) ?? null;
      const lKey = `${sym}|${tf}|${all.length}|${all[0].t}|${newest}|${all[all.length - 1].c}|${all[all.length - 1].h}|${all[all.length - 1].l}|${all[all.length - 1].v ?? ""}|${oi ? `${oi.length}:${oi[oi.length - 1].t}:${oi[oi.length - 1].v}` : "-"}`;
      if (liqCache.current?.key !== lKey) {
        const { mode, inflow } = inflowFor(all, oi, tfMs);
        const segments = buildSegments(all, inflow);
        liqCache.current = { key: lKey, mode, segments, top: [...segments].sort((a, b) => b.amount - a.amount).slice(0, 12) };
      }
      const { mode, segments, top } = liqCache.current;
      const rowPx = 3;
      const rows = Math.max(1, Math.floor((priceBottom - pad) / rowPx));
      const lastVis = Math.min(all.length - 1, Math.ceil(start + count) - 1);
      const grid = buildGrid(segments, first, lastVis, lo, hi, rows, 400);
      let hover: { price: number; pct: number } | null = null;
      if (grid.cols > 0 && grid.max > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, plotW, priceBottom);
        ctx.clip();
        const rowH = (priceBottom - pad) / rows;
        const colW = grid.group * step;
        for (let r = 0; r < grid.rows; r++) {
          for (let c = 0; c < grid.cols; c++) {
            const v = grid.cells[r * grid.cols + c];
            if (v <= 0) continue;
            const [cr, cg, cb] = heatColor(Math.sqrt(v / grid.max));
            ctx.fillStyle = `rgba(${cr},${cg},${cb},0.85)`;
            const x0 = xOf(first + c * grid.group) - step / 2;
            ctx.fillRect(x0, pad + r * rowH, Math.min(colW, plotW - x0) + 0.5, rowH + 0.5);
          }
        }
        ctx.restore();
        const hm = mouse.current;
        if (hm && hm.x < plotW && hm.y > pad && hm.y < priceBottom) {
          const hc = Math.floor((Math.floor(hm.x / step + start) - first) / grid.group);
          const hr = Math.min(grid.rows - 1, Math.floor((hm.y - pad) / rowH));
          if (hc >= 0 && hc < grid.cols) hover = { price: hi - ((hr + 0.5) / grid.rows) * (hi - lo), pct: (grid.cells[hr * grid.cols + hc] / grid.max) * 100 };
        }
      }
      cv.dataset.liq = JSON.stringify({
        mode,
        rows: grid.rows,
        cols: grid.cols,
        group: grid.group,
        max: grid.max,
        segments: segments.length,
        hover,
        top: top.map((s) => ({ side: s.side, lev: s.lev, price: s.price, amount: s.amount, fromT: all[s.from].t, toT: s.to < all.length ? all[s.to].t : null })),
      });
      // legend (bottom-left of the price pane): what this is, where the numbers come from, and the colour scale
      const label = `Liq heatmap (estimate · ${mode === "oi" ? "open interest" : "volume"} based)${hover ? ` · ${hover.pct.toFixed(0)}% of peak` : ""}`;
      ctx.fillStyle = "rgba(11,14,20,0.7)";
      ctx.fillRect(4, priceBottom - 20, ctx.measureText(label).width + 86, 16);
      ctx.fillStyle = "#c7cfdd";
      ctx.fillText(label, 10, priceBottom - 12);
      const gx = 10 + ctx.measureText(label).width + 8;
      for (let i = 0; i < 60; i++) {
        const [lr, lg, lb] = heatColor(i / 59);
        ctx.fillStyle = `rgb(${lr},${lg},${lb})`;
        ctx.fillRect(gx + i, priceBottom - 17, 1, 10);
      }
    }

    // candles
    const bw = Math.min(16, Math.max(1, step * 0.64));
    data.forEach((c, k) => {
      const x = xOf(first + k);
      if (x < -bw || x > plotW + bw) return;
      ctx.strokeStyle = ctx.fillStyle = c.c >= c.o ? UP : DOWN;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, y(c.h));
      ctx.lineTo(Math.round(x) + 0.5, y(c.l));
      ctx.stroke();
      ctx.fillRect(x - bw / 2, y(Math.max(c.o, c.c)), bw, Math.max(1, Math.abs(y(c.o) - y(c.c))));
    });

    // moving averages (not part of the price autoscale), clipped to the price pane
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, plotW, priceBottom);
    ctx.clip();
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";
    const lastIdx = Math.min(all.length, Math.ceil(start + count) + 1);
    if (bands) {
      const from = Math.max(0, first - 1);
      // translucent fill between the bands, one polygon per unbroken run
      ctx.fillStyle = BB_FILL;
      for (let k = from; k < lastIdx; ) {
        if (bands.upper[k] === null) {
          k++;
          continue;
        }
        let e = k;
        while (e + 1 < lastIdx && bands.upper[e + 1] !== null) e++;
        ctx.beginPath();
        for (let j = k; j <= e; j++) (j === k ? ctx.moveTo : ctx.lineTo).call(ctx, xOf(j), y(bands.upper[j]!));
        for (let j = e; j >= k; j--) ctx.lineTo(xOf(j), y(bands.lower[j]!));
        ctx.closePath();
        ctx.fill();
        k = e + 1;
      }
      ctx.lineWidth = 1;
      ctx.strokeStyle = BB_COLOR;
      for (const [ser, dash] of [[bands.upper, false], [bands.mid, true], [bands.lower, false]] as const) {
        ctx.setLineDash(dash ? [4, 3] : []);
        ctx.beginPath();
        let pen = false;
        for (let k = from; k < lastIdx; k++) {
          const val = ser[k];
          if (val === null) {
            pen = false;
            continue;
          }
          if (pen) ctx.lineTo(xOf(k), y(val));
          else {
            ctx.moveTo(xOf(k), y(val));
            pen = true;
          }
        }
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.lineWidth = 1.5;
    }
    maSeries.forEach((ser, si) => {
      if (!ser) return;
      ctx.strokeStyle = MA_COLORS[si];
      ctx.beginPath();
      let pen = false;
      for (let k = Math.max(0, first - 1); k < lastIdx; k++) {
        const val = ser[k];
        if (val === null || !Number.isFinite(val)) {
          pen = false;
          continue;
        }
        if (pen) ctx.lineTo(xOf(k), y(val));
        else {
          ctx.moveTo(xOf(k), y(val));
          pen = true;
        }
      }
      ctx.stroke();
    });
    ctx.restore();

    // Fibonacci retracements (and the one being placed), clipped to the price pane
    {
      const ext = fibExtRef.current;
      const levels = fibLevels(ext);
      const drawFib = (f: Pick<Fib, "a" | "b">, alpha: number, handles: boolean) => {
        const xA = xOf(timeToIndex(all, f.a.t, tfMs));
        const xB = xOf(timeToIndex(all, f.b.t, tfMs));
        const left = Math.min(xA, xB);
        ctx.globalAlpha = alpha;
        const ys = levels.map((r) => y(levelPrice(f, r)));
        for (let i = 0; i + 1 < levels.length && levels[i + 1] <= 1; i++) {
          ctx.fillStyle = fibColor(levels[i + 1]);
          ctx.globalAlpha = alpha * 0.07;
          ctx.fillRect(left, Math.min(ys[i], ys[i + 1]), plotW - left, Math.abs(ys[i + 1] - ys[i]));
        }
        ctx.globalAlpha = alpha;
        ctx.lineWidth = 1;
        levels.forEach((r, i) => {
          const yy = Math.round(ys[i]) + 0.5;
          ctx.strokeStyle = ctx.fillStyle = fibColor(r);
          ctx.beginPath();
          ctx.moveTo(left, yy);
          ctx.lineTo(plotW, yy);
          ctx.stroke();
          ctx.fillText(`${r} (${fmt(levelPrice(f, r), dp)})`, Math.max(left, 0) + 5, yy - 7);
        });
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = "rgba(255,255,255,0.55)";
        ctx.beginPath();
        ctx.moveTo(xA, y(f.a.p));
        ctx.lineTo(xB, y(f.b.p));
        ctx.stroke();
        ctx.setLineDash([]);
        if (handles) {
          for (const [hx, hy] of [[xA, y(f.a.p)], [xB, y(f.b.p)]]) {
            ctx.beginPath();
            ctx.arc(hx, hy, 4, 0, Math.PI * 2);
            ctx.fillStyle = "#0b0e14";
            ctx.fill();
            ctx.strokeStyle = "#e6eaf2";
            ctx.lineWidth = 1.5;
            ctx.stroke();
          }
        }
        ctx.globalAlpha = 1;
      };
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, plotW, priceBottom);
      ctx.clip();
      for (const f of fibsRef.current) drawFib(f, 0.9, true);
      // placement preview: the first point, and the retracement following the cursor once there is one
      const a0 = pendingA.current;
      if (fibStepRef.current === 2 && a0) {
        const pm = mouse.current;
        if (pm && pm.x < plotW && pm.y < priceBottom) {
          const b0 = { t: snapTime(all, pm.x / step + start - 0.5, tfMs), p: hi - ((pm.y - pad) / (priceBottom - pad)) * (hi - lo) };
          drawFib({ a: a0, b: b0 }, 0.6, false);
        }
        ctx.beginPath();
        ctx.arc(xOf(timeToIndex(all, a0.t, tfMs)), y(a0.p), 4, 0, Math.PI * 2);
        ctx.fillStyle = "#e6eaf2";
        ctx.fill();
      }
      ctx.restore();
      cv.dataset.fib = JSON.stringify({
        step: fibStepRef.current,
        ext,
        items: fibsRef.current.map((f) => ({
          id: f.id,
          a: f.a,
          b: f.b,
          ax: xOf(timeToIndex(all, f.a.t, tfMs)),
          ay: y(f.a.p),
          bx: xOf(timeToIndex(all, f.b.t, tfMs)),
          by: y(f.b.p),
          levels: levels.map((r) => ({ r, price: levelPrice(f, r), y: y(levelPrice(f, r)) })),
        })),
      });
    }

    // RSI pane: fixed 0-100 scale with the 30 / 70 levels
    if (rsiVals) {
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.beginPath();
      ctx.moveTo(0, priceBottom + 3.5);
      ctx.lineTo(plotW, priceBottom + 3.5);
      ctx.stroke();
      ctx.fillStyle = "rgba(244,114,182,0.06)";
      ctx.fillRect(0, rsiY(RSI_OVERBOUGHT), plotW, rsiY(RSI_OVERSOLD) - rsiY(RSI_OVERBOUGHT));
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = "rgba(255,255,255,0.22)";
      ctx.beginPath();
      for (const lvl of [RSI_OVERBOUGHT, RSI_OVERSOLD]) {
        ctx.moveTo(0, Math.round(rsiY(lvl)) + 0.5);
        ctx.lineTo(plotW, Math.round(rsiY(lvl)) + 0.5);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, priceBottom + 4, plotW, rsiBottom - priceBottom - 1);
      ctx.clip();
      ctx.strokeStyle = RSI_COLOR;
      ctx.lineWidth = 1.5;
      ctx.lineJoin = "round";
      ctx.beginPath();
      let rpen = false;
      for (let k = Math.max(0, first - 1); k < Math.min(all.length, Math.ceil(start + count) + 1); k++) {
        const val = rsiVals[k];
        if (val === null) {
          rpen = false;
          continue;
        }
        if (rpen) ctx.lineTo(xOf(k), rsiY(val));
        else {
          ctx.moveTo(xOf(k), rsiY(val));
          rpen = true;
        }
      }
      ctx.stroke();
      ctx.restore();
      const rv = rsiVals[focusAt] ?? null;
      cv.dataset.rsi = JSON.stringify({ label: `RSI ${rcfg.period}`, value: rv });
      ctx.fillStyle = RSI_COLOR;
      ctx.fillText(`RSI ${rcfg.period}  ${rv === null ? "—" : rv.toFixed(2)}`, 10, priceBottom + 15);
      ctx.fillStyle = "#7d8799";
      ctx.fillText(String(RSI_OVERBOUGHT), plotW + 8, rsiY(RSI_OVERBOUGHT));
      ctx.fillText(String(RSI_OVERSOLD), plotW + 8, rsiY(RSI_OVERSOLD));
    } else {
      cv.dataset.rsi = "";
    }

    // Stochastic pane: %K and %D on a fixed 0-100 scale with the 20 / 80 levels
    if (stochVals) {
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.beginPath();
      ctx.moveTo(0, stochBlockTop + 3.5);
      ctx.lineTo(plotW, stochBlockTop + 3.5);
      ctx.stroke();
      ctx.fillStyle = "rgba(34,211,238,0.05)";
      ctx.fillRect(0, stochY(STOCH_OVERBOUGHT), plotW, stochY(STOCH_OVERSOLD) - stochY(STOCH_OVERBOUGHT));
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = "rgba(255,255,255,0.22)";
      ctx.beginPath();
      for (const lvl of [STOCH_OVERBOUGHT, STOCH_OVERSOLD]) {
        ctx.moveTo(0, Math.round(stochY(lvl)) + 0.5);
        ctx.lineTo(plotW, Math.round(stochY(lvl)) + 0.5);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, stochBlockTop + 4, plotW, stochBottom - stochBlockTop - 1);
      ctx.clip();
      ctx.lineWidth = 1.5;
      ctx.lineJoin = "round";
      for (const [ser, color] of [[stochVals.d, STOCH_D_COLOR], [stochVals.k, STOCH_K_COLOR]] as const) {
        ctx.strokeStyle = color;
        ctx.beginPath();
        let spen = false;
        for (let k = Math.max(0, first - 1); k < Math.min(all.length, Math.ceil(start + count) + 1); k++) {
          const val = ser[k];
          if (val === null) {
            spen = false;
            continue;
          }
          if (spen) ctx.lineTo(xOf(k), stochY(val));
          else {
            ctx.moveTo(xOf(k), stochY(val));
            spen = true;
          }
        }
        ctx.stroke();
      }
      ctx.restore();
      const kv = stochVals.k[focusAt] ?? null;
      const dv = stochVals.d[focusAt] ?? null;
      cv.dataset.stoch = JSON.stringify({ label: stochLabel(scfg), k: kv, d: dv });
      ctx.fillStyle = STOCH_K_COLOR;
      const head = `${stochLabel(scfg)}  K ${kv === null ? "—" : kv.toFixed(2)}`;
      ctx.fillText(head, 10, stochBlockTop + 15);
      ctx.fillStyle = STOCH_D_COLOR;
      ctx.fillText(`D ${dv === null ? "—" : dv.toFixed(2)}`, 10 + ctx.measureText(head).width + 12, stochBlockTop + 15);
      ctx.fillStyle = "#7d8799";
      ctx.fillText(String(STOCH_OVERBOUGHT), plotW + 8, stochY(STOCH_OVERBOUGHT));
      ctx.fillText(String(STOCH_OVERSOLD), plotW + 8, stochY(STOCH_OVERSOLD));
    } else {
      cv.dataset.stoch = "";
    }

    // volume pane
    if (hasVol) {
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.beginPath();
      ctx.moveTo(0, volTop + 3.5);
      ctx.lineTo(plotW, volTop + 3.5);
      ctx.stroke();
      data.forEach((c, k) => {
        if (c.v === undefined) return;
        const x = xOf(first + k);
        if (x < -bw || x > plotW + bw) return;
        const bh = Math.max(1, (c.v / maxV) * volUsable);
        ctx.fillStyle = c.c >= c.o ? UP_DIM : DOWN_DIM;
        ctx.fillRect(x - bw / 2, volBottom - bh, bw, bh);
      });
      ctx.fillStyle = "#7d8799";
      const newest = data[data.length - 1];
      ctx.fillText(`Vol ${newest?.v !== undefined ? formatVolume(newest.v) : ""}`, 10, volTop + 15);
      ctx.fillText(formatVolume(maxV), plotW + 8, volBottom - volUsable); // axis: height of the tallest bar
    }

    // marker where the available history begins
    if (start < 0 && older.current.done.has(`${sym}|${tf}`)) {
      const x0 = Math.round(xOf(0) - step / 2) + 0.5;
      ctx.setLineDash([2, 4]);
      ctx.strokeStyle = "rgba(255,255,255,0.25)";
      ctx.beginPath();
      ctx.moveTo(x0, 0);
      ctx.lineTo(x0, plotH);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#7d8799";
      ctx.textAlign = "right";
      ctx.fillText("start of history", x0 - 6, 62);
      ctx.textAlign = "left";
    }

    // last price: line when it is on screen, label always (pinned to the edge when it is off screen)
    if (rawY >= pad && rawY <= priceBottom) {
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = lc;
      ctx.beginPath();
      ctx.moveTo(0, ly);
      ctx.lineTo(plotW, ly);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.fillStyle = lc;
    ctx.fillRect(plotW + 2, ly - 9, axisW - 2, 18);
    ctx.fillStyle = "#0b0e14";
    ctx.fillText(fmt(lastC.c, dp), plotW + 8, ly);

    if (older.current.loading) {
      ctx.fillStyle = "#7d8799";
      ctx.fillText("loading history…", 10, 62);
    }

    // moving-average legend: the value under the cursor, else at the newest visible candle
    {
      const hm = mouse.current;
      const hIdx = hm && hm.x < plotW && hm.y < plotH ? Math.floor(hm.x / step + start) : -1;
      const at = hIdx >= 0 && hIdx < all.length ? hIdx : Math.min(all.length, Math.ceil(start + count)) - 1;
      const shown: { text: string; color: string }[] = [];
      const report: { label: string; value: number | null }[] = [];
      cfg.forEach((slot, si) => {
        const ser = maSeries[si];
        if (!ser) return;
        const val = ser[at] ?? null;
        report.push({ label: maLabel(slot), value: val });
        shown.push({ text: `${maLabel(slot)} ${val === null ? "—" : fmt(val, dp)}`, color: MA_COLORS[si] });
      });
      cv.dataset.ma = JSON.stringify(report);
      if (shown.length) {
        let x = 10;
        const total = shown.reduce((a, it) => a + ctx.measureText(it.text).width + 14, -14);
        ctx.fillStyle = "rgba(11,14,20,0.6)";
        ctx.fillRect(4, 22, total + 12, 16);
        for (const it of shown) {
          ctx.fillStyle = it.color;
          ctx.fillText(it.text, x, 30);
          x += ctx.measureText(it.text).width + 14;
        }
      }
    }

    // Bollinger legend (second row): upper / middle / lower at the same candle as the averages
    {
      const hm = mouse.current;
      const hIdx = hm && hm.x < plotW && hm.y < plotH ? Math.floor(hm.x / step + start) : -1;
      const at = hIdx >= 0 && hIdx < all.length ? hIdx : Math.min(all.length, Math.ceil(start + count)) - 1;
      if (bands) {
        const u = bands.upper[at] ?? null;
        const mi = bands.mid[at] ?? null;
        const lo2 = bands.lower[at] ?? null;
        cv.dataset.bb = JSON.stringify({ label: bbLabel(bb), upper: u, mid: mi, lower: lo2 });
        const txt = `${bbLabel(bb)}  U ${u === null ? "—" : fmt(u, dp)}  M ${mi === null ? "—" : fmt(mi, dp)}  L ${lo2 === null ? "—" : fmt(lo2, dp)}`;
        ctx.fillStyle = "rgba(11,14,20,0.6)";
        ctx.fillRect(4, 38, ctx.measureText(txt).width + 12, 16);
        ctx.fillStyle = BB_COLOR;
        ctx.fillText(txt, 10, 46);
      } else {
        cv.dataset.bb = "";
      }
    }

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
      const inVol = hasVol && m.y > volTop;
      const inStoch = !inVol && hasStoch && m.y > stochBlockTop;
      const inRsi = !inVol && !inStoch && hasRsi && m.y > priceBottom;
      const pct = (top: number, bottom: number) => Math.min(100, Math.max(0, 100 - ((m.y - top) / (bottom - top)) * 100)).toFixed(1);
      const tag = inVol
        ? formatVolume(Math.max(0, ((volBottom - m.y) / volUsable) * maxV))
        : inStoch
          ? pct(stochTop, stochBottom)
          : inRsi
            ? pct(rsiTop, rsiBottom)
            : fmt(hi - ((m.y - pad) / (priceBottom - pad)) * (hi - lo), dp);
      ctx.fillStyle = "#2a3140";
      ctx.fillRect(plotW + 2, m.y - 9, axisW - 2, 18);
      ctx.fillStyle = "#e6eaf2";
      ctx.fillText(tag, plotW + 8, m.y);
      const hoverIdx = Math.floor(m.x / step + start);
      if (hoverIdx >= 0 && hoverIdx < all.length) {
        const c = all[hoverIdx];
        // time tag on the x axis
        const timeTag = formatFullTime(c.t, tfMs);
        const tw = ctx.measureText(timeTag).width + 12;
        const tx = Math.min(Math.max(xOf(hoverIdx) - tw / 2, 0), plotW - tw);
        ctx.fillStyle = "#2a3140";
        ctx.fillRect(tx, plotH + 3, tw, 18);
        ctx.fillStyle = "#e6eaf2";
        ctx.textAlign = "center";
        ctx.fillText(timeTag, tx + tw / 2, plotH + 12);
        ctx.textAlign = "left";
        // OHLC readout at the top-left of the plot
        const chg = c.o ? (c.c / c.o - 1) * 100 : 0;
        const ro = `O ${fmt(c.o, dp)}  H ${fmt(c.h, dp)}  L ${fmt(c.l, dp)}  C ${fmt(c.c, dp)}  ${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%${c.v !== undefined ? `  V ${formatVolume(c.v)}` : ""}`;
        const rw = ctx.measureText(ro).width + 12;
        ctx.fillStyle = "rgba(11,14,20,0.85)";
        ctx.fillRect(4, 2, rw, 18);
        ctx.fillStyle = c.c >= c.o ? UP : DOWN;
        ctx.fillText(ro, 10, 11);
      }
    }
  }, [market, sym, tf, loading]);

  const drawRef = useRef(draw);
  drawRef.current = draw;

  // ── view operations ──
  const geom = useCallback(() => {
    const cv = ref.current!;
    const plotW = Math.max(50, cv.clientWidth - AXIS_W - PAD);
    const all = market.candlesFor(sym, tf);
    const count = resolveCount(view.current, plotW);
    return { plotW, all, count, step: plotW / count };
  }, [market, sym, tf]);
  const commit = useCallback((offset: number, count: number | null) => {
    view.current = { count, offset };
    setScrolled(offset > 0.5);
    setZoomed(count !== null);
    drawRef.current();
  }, []);
  /** Scroll by `candles` (positive = back in time). */
  const panBy = useCallback(
    (candles: number) => {
      const g = geom();
      commit(clampOffset(view.current.offset + candles, g.count, g.all.length), view.current.count);
    },
    [geom, commit]
  );
  /** Zoom by `factor` (<1 in, >1 out), keeping the candle at `frac` (0..1 across the plot) in place. */
  const zoomBy = useCallback(
    (factor: number, frac = 1) => {
      const g = geom();
      const r = zoomAt(view.current, g.count, g.all.length, frac, factor);
      commit(r.offset, r.count);
    },
    [geom, commit]
  );
  const reset = useCallback(() => commit(0, null), [commit]);
  const updateMa = useCallback((index: number, slot: MaSlot) => {
    const next = maRef.current.map((s, i) => (i === index ? slot : s));
    maRef.current = next;
    setMaCfg(next);
    saveMaConfig(next);
    drawRef.current();
  }, []);
  const updateStoch = useCallback((next: StochConfig) => {
    stochRef.current = next;
    setStochCfg(next);
    saveStochConfig(next);
    drawRef.current();
  }, []);
  const updateRsi = useCallback((next: RsiConfig) => {
    rsiRef.current = next;
    setRsiCfg(next);
    saveRsiConfig(next);
    drawRef.current();
  }, []);
  const updateBb = useCallback((next: BbConfig) => {
    bbRef.current = next;
    setBbCfg(next);
    saveBbConfig(next);
    drawRef.current();
  }, []);
  // the indicator popovers close on Escape or a click outside them
  useEffect(() => {
    if (!panel) return;
    const onDown = (e: PointerEvent) => {
      if (controls.current && !controls.current.contains(e.target as Node)) {
        setPanel(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPanel(null);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [panel]);
  const toggleLiq = useCallback(() => {
    const next = !liqOn.current;
    liqOn.current = next;
    setLiqShown(next);
    saveLiqPref(next);
    drawRef.current();
  }, []);
  const toggleVol = useCallback(() => {
    const next = !volOn.current;
    volOn.current = next;
    setVolShown(next);
    saveVolumePref(next);
    drawRef.current();
  }, []);

  // each symbol has its own retracements; switching symbol also abandons a half-placed one
  useEffect(() => {
    const list = loadFibs(sym);
    fibsRef.current = list;
    setFibs(list);
    fibStepRef.current = 0;
    pendingA.current = null;
    setFibStep(0);
    fibDrag.current = null;
    drawRef.current();
  }, [sym]);
  const setFibList = useCallback(
    (list: Fib[]) => {
      fibsRef.current = list;
      setFibs(list);
      saveFibs(sym, list);
      drawRef.current();
    },
    [sym]
  );
  const startFib = useCallback((step: 0 | 1 | 2) => {
    fibStepRef.current = step;
    setFibStep(step);
    if (step === 0) pendingA.current = null;
    drawRef.current();
  }, []);
  useEffect(() => {
    if (fibStep === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") startFib(0);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [fibStep, startFib]);

  // changing symbol or timeframe returns to the live edge (the zoom level is kept)
  useEffect(() => {
    view.current.offset = 0;
    lastT.current = null;
    setScrolled(false);
    drawRef.current();
  }, [sym, tf]);

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

  // wheel: zoom at the cursor; shift+wheel or a horizontal wheel/trackpad swipe pans.
  // Needs a non-passive native listener so the page doesn't scroll underneath.
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const g = geom();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const dx = e.deltaX * unit;
      const dy = Math.max(-120, Math.min(120, e.deltaY * unit));
      if (e.shiftKey || Math.abs(dx) > Math.abs(dy)) panBy(-(dx || dy) / g.step);
      else zoomBy(Math.exp(dy * 0.0015), (e.clientX - cv.getBoundingClientRect().left) / g.plotW);
    };
    cv.addEventListener("wheel", onWheel, { passive: false });
    return () => cv.removeEventListener("wheel", onWheel);
  }, [geom, panBy, zoomBy]);

  // ── pointer input: one pointer pans, two pinch-zoom ──
  /** Pixel position (canvas coordinates) -> the (candle time, price) it stands for, using the last drawn geometry. */
  const toFibPoint = (x: number, yPx: number): FibPoint | null => {
    const g = geo.current;
    if (!g) return null;
    return { t: snapTime(g.all, x / g.step + g.start - 0.5, g.tfMs), p: g.hi - ((yPx - g.pad) / (g.priceBottom - g.pad)) * (g.hi - g.lo) };
  };
  const fibHandles = () => {
    const g = geo.current;
    if (!g) return [];
    const out: { id: string; which: "a" | "b"; x: number; y: number }[] = [];
    for (const f of fibsRef.current) {
      for (const which of ["a", "b"] as const) {
        const pt = f[which];
        out.push({
          id: f.id,
          which,
          x: (timeToIndex(g.all, pt.t, g.tfMs) - g.start + 0.5) * g.step,
          y: g.pad + ((g.hi - pt.p) / (g.hi - g.lo)) * (g.priceBottom - g.pad),
        });
      }
    }
    return out;
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    {
      // Fibonacci: placing a point, or grabbing an anchor, takes precedence over panning
      const r = e.currentTarget.getBoundingClientRect();
      const lx = e.clientX - r.left;
      const ly = e.clientY - r.top;
      const g = geo.current;
      if (g && lx < g.plotW && ly < g.priceBottom) {
        if (fibStepRef.current > 0) {
          const pt = toFibPoint(lx, ly);
          lastFibAction.current = Date.now();
          if (pt && fibStepRef.current === 1) {
            pendingA.current = pt;
            startFib(2);
          } else if (pt && pendingA.current) {
            const a = pendingA.current;
            if (a.t !== pt.t || a.p !== pt.p) {
              setFibList([...fibsRef.current, { id: newFibId(), a, b: pt }]);
              startFib(0);
              setPanel(null);
            }
          }
          return;
        }
        const h = nearestHandle(fibHandles(), lx, ly, e.pointerType === "mouse" ? 9 : 16);
        if (h) {
          fibDrag.current = { id: h.id, which: h.which };
          lastFibAction.current = Date.now();
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            /* synthetic pointer: dragging still works while over the canvas */
          }
          e.currentTarget.style.cursor = "move";
          return;
        }
      }
    }
    try {
      e.currentTarget.setPointerCapture(e.pointerId); // keeps the drag going outside the canvas
    } catch {
      /* not an active pointer (e.g. synthetic event): panning still works while over the canvas */
    }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (e.pointerType !== "mouse") mouse.current = null;
    e.currentTarget.style.cursor = "grabbing";
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (e.pointerType === "mouse") mouse.current = { x: e.clientX - r.left, y: e.clientY - r.top };
    const drag = fibDrag.current;
    if (drag) {
      const pt = toFibPoint(e.clientX - r.left, e.clientY - r.top);
      const g = geo.current;
      if (pt && g) {
        const py = Math.min(Math.max(e.clientY - r.top, g.pad), g.priceBottom);
        const clamped = toFibPoint(e.clientX - r.left, py)!;
        fibsRef.current = fibsRef.current.map((f) => (f.id === drag.id ? { ...f, [drag.which]: clamped } : f));
      }
      drawRef.current();
      return;
    }
    if (pointers.current.size === 0) {
      const g = geo.current;
      const lx = e.clientX - r.left;
      const ly = e.clientY - r.top;
      const inPane = !!g && lx < g.plotW && ly < g.priceBottom;
      e.currentTarget.style.cursor = fibStepRef.current > 0 && inPane ? "crosshair" : inPane && nearestHandle(fibHandles(), lx, ly, 9) ? "move" : "";
    }
    const prev = pointers.current.get(e.pointerId);
    if (prev) {
      const g = geom();
      if (pointers.current.size === 1) {
        panBy((e.clientX - prev.x) / g.step);
      } else if (pointers.current.size === 2) {
        const other = [...pointers.current.entries()].find(([id]) => id !== e.pointerId)![1];
        const d0 = Math.hypot(prev.x - other.x, prev.y - other.y);
        const d1 = Math.hypot(e.clientX - other.x, e.clientY - other.y);
        if (d0 > 10 && d1 > 10) zoomBy(d0 / d1, ((e.clientX + other.x) / 2 - r.left) / g.plotW);
      }
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    drawRef.current();
  };
  const onPointerEnd = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (fibDrag.current) {
      fibDrag.current = null;
      setFibList(fibsRef.current); // keep and save where the anchor was dropped
      e.currentTarget.style.cursor = "";
      return;
    }
    pointers.current.delete(e.pointerId);
    if (pointers.current.size === 0) e.currentTarget.style.cursor = "";
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLCanvasElement>) => {
    const g = geom();
    const page = Math.max(1, Math.round(g.count * (e.shiftKey ? 1 : 0.1)));
    switch (e.key) {
      case "ArrowLeft":
        panBy(page);
        break;
      case "ArrowRight":
        panBy(-page);
        break;
      case "+":
      case "=":
        zoomBy(0.8);
        break;
      case "-":
      case "_":
        zoomBy(1.25);
        break;
      case "Home":
        commit(maxOffset(g.all.length, g.count), view.current.count);
        break;
      case "End":
      case "0":
        commit(0, view.current.count);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const btn = "rounded border border-white/15 bg-[#10141c]/90 px-2 py-0.5 text-slate-300 hover:bg-white/10";
  return (
    <div className="relative h-full w-full">
      <canvas
        ref={ref}
        className="h-full w-full cursor-grab touch-none focus-visible:[outline-offset:-2px]"
        tabIndex={0}
        role="application"
        aria-label="Price chart. Scroll to zoom, drag to pan, arrow keys scroll, plus and minus zoom, End returns to the latest candle."
        title="Scroll to zoom · drag to pan · double-click to reset"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onPointerLeave={() => {
          if (pointers.current.size === 0) {
            mouse.current = null;
            drawRef.current();
          }
        }}
        onDoubleClick={() => {
          if (Date.now() - lastFibAction.current < 500) return; // the clicks of a placement are not a reset
          reset();
        }}
        onKeyDown={onKeyDown}
      />
      {fibStep > 0 && (
        <div role="status" className="pointer-events-none absolute left-1/2 top-12 -translate-x-1/2 rounded border border-white/15 bg-[#10141c]/95 px-3 py-1 text-xs text-slate-200">
          {fibStep === 1 ? "Click the start of the move" : "Click the end of the move"} · Esc to cancel
        </div>
      )}
      <div ref={controls} className="absolute right-[84px] top-1.5 text-xs">
      <div className="flex items-center justify-end gap-1">
        {scrolled && (
          <button onClick={() => commit(0, view.current.count)} className="rounded bg-[#26d07c] px-2 py-0.5 font-bold text-[#0b0e14]">
            Live ▸
          </button>
        )}
        <button
          aria-label="Volume"
          aria-pressed={volShown}
          title={volShown ? "Hide volume" : "Show volume"}
          onClick={toggleVol}
          className={`${btn} ${volShown ? "text-white" : "text-slate-500"}`}
        >
          Vol
        </button>
        <button
          aria-label="Moving averages"
          aria-pressed={maCfg.some((s) => s.enabled)}
          aria-expanded={panel === "ma"}
          title="Moving averages"
          onClick={() => setPanel((p) => (p === "ma" ? null : "ma"))}
          className={`${btn} ${maCfg.some((s) => s.enabled) ? "text-white" : "text-slate-500"}`}
        >
          MA
        </button>
        <button
          aria-label="Bollinger Bands"
          aria-pressed={bbCfg.enabled}
          aria-expanded={panel === "bb"}
          title="Bollinger Bands"
          onClick={() => setPanel((p) => (p === "bb" ? null : "bb"))}
          className={`${btn} ${bbCfg.enabled ? "text-white" : "text-slate-500"}`}
        >
          BB
        </button>
        <button
          aria-label="RSI"
          aria-pressed={rsiCfg.enabled}
          aria-expanded={panel === "rsi"}
          title="Relative Strength Index"
          onClick={() => setPanel((p) => (p === "rsi" ? null : "rsi"))}
          className={`${btn} ${rsiCfg.enabled ? "text-white" : "text-slate-500"}`}
        >
          RSI
        </button>
        <button
          aria-label="Stochastic"
          aria-pressed={stochCfg.enabled}
          aria-expanded={panel === "stoch"}
          title="Stochastic oscillator"
          onClick={() => setPanel((p) => (p === "stoch" ? null : "stoch"))}
          className={`${btn} ${stochCfg.enabled ? "text-white" : "text-slate-500"}`}
        >
          Stoch
        </button>
        <button
          aria-label="Liquidation heatmap"
          aria-pressed={liqShown}
          title={liqShown ? "Hide the estimated liquidation heatmap" : "Show an estimated liquidation heatmap"}
          onClick={toggleLiq}
          className={`${btn} ${liqShown ? "text-white" : "text-slate-500"}`}
        >
          Liq
        </button>
        <button
          aria-label="Fibonacci retracement"
          aria-pressed={fibs.length > 0 || fibStep > 0}
          aria-expanded={panel === "fib"}
          title="Fibonacci retracement"
          onClick={() => setPanel((p) => (p === "fib" ? null : "fib"))}
          className={`${btn} ${fibs.length > 0 || fibStep > 0 ? "text-white" : "text-slate-500"}`}
        >
          Fib
        </button>
        <button aria-label="Zoom out" title="Zoom out" onClick={() => zoomBy(1.25)} className={btn}>
          −
        </button>
        <button aria-label="Zoom in" title="Zoom in" onClick={() => zoomBy(0.8)} className={btn}>
          +
        </button>
        {(zoomed || scrolled) && (
          <button aria-label="Reset view" title="Reset zoom and jump to the latest candle" onClick={reset} className={btn}>
            Reset
          </button>
        )}
      </div>
      {panel === "fib" && (
        <div role="dialog" aria-label="Fibonacci retracement" className="mt-1 w-64 rounded border border-white/15 bg-[#10141c] p-2 shadow-lg">
          <button
            aria-label="Draw retracement"
            disabled={fibs.length >= FIB_MAX_PER_SYMBOL}
            onClick={() => {
              startFib(1);
              setPanel(null);
            }}
            className="mb-1 w-full rounded bg-[#26d07c] px-2 py-1 font-bold text-[#0b0e14] disabled:opacity-40"
          >
            {fibs.length >= FIB_MAX_PER_SYMBOL ? `Limit of ${FIB_MAX_PER_SYMBOL} reached` : "Draw retracement"}
          </button>
          <label className="flex items-center gap-2 py-0.5">
            <input
              type="checkbox"
              aria-label="Show extensions"
              checked={fibExt}
              onChange={(e) => {
                fibExtRef.current = e.target.checked;
                setFibExt(e.target.checked);
                saveFibExtensions(e.target.checked);
                drawRef.current();
              }}
            />
            <span className="text-slate-200">Extensions (1.272, 1.618, 2.618)</span>
          </label>
          {fibs.length === 0 ? (
            <div className="py-1 text-slate-500">None on {sym}. Pick two points on the chart.</div>
          ) : (
            <div className="mt-1 border-t border-white/10 pt-1">
              {fibs.map((f, i) => (
                <div key={f.id} className="flex items-center justify-between gap-2 py-0.5 text-slate-300">
                  <span>
                    {i + 1}. {fmt(f.a.p, dpFor(sym))} → {fmt(f.b.p, dpFor(sym))}
                  </span>
                  <button aria-label={`Delete retracement ${i + 1}`} title="Delete" onClick={() => setFibList(fibs.filter((x) => x.id !== f.id))} className="rounded px-1 text-slate-400 hover:bg-white/10 hover:text-white">
                    ×
                  </button>
                </div>
              ))}
              <button aria-label="Clear all retracements" onClick={() => setFibList([])} className="mt-1 text-slate-400 underline hover:text-white">
                Clear all
              </button>
            </div>
          )}
        </div>
      )}
      {panel === "stoch" && (
        <div role="dialog" aria-label="Stochastic" className="mt-1 w-56 rounded border border-white/15 bg-[#10141c] p-2 shadow-lg">
          <label className="flex items-center gap-2 py-0.5">
            <input type="checkbox" aria-label="Show Stochastic" checked={stochCfg.enabled} onChange={(e) => updateStoch({ ...stochCfg, enabled: e.target.checked })} />
            <span className="inline-block h-0.5 w-3" style={{ background: STOCH_K_COLOR }} />
            <span className="inline-block h-0.5 w-3" style={{ background: STOCH_D_COLOR }} />
            <span className="text-slate-200">Stochastic</span>
          </label>
          <NumField label="Stochastic K period" text="%K period" value={stochCfg.k} min={STOCH_MIN_K} max={STOCH_MAX_K} integer onCommit={(v) => updateStoch({ ...stochCfg, k: v })} />
          <NumField label="Stochastic K smoothing" text="%K smoothing" value={stochCfg.smooth} min={1} max={STOCH_MAX_SMOOTH} integer onCommit={(v) => updateStoch({ ...stochCfg, smooth: v })} />
          <NumField label="Stochastic D period" text="%D period" value={stochCfg.d} min={1} max={STOCH_MAX_SMOOTH} integer onCommit={(v) => updateStoch({ ...stochCfg, d: v })} />
        </div>
      )}
      {panel === "rsi" && (
        <div role="dialog" aria-label="RSI" className="mt-1 w-56 rounded border border-white/15 bg-[#10141c] p-2 shadow-lg">
          <label className="flex items-center gap-2 py-0.5">
            <input type="checkbox" aria-label="Show RSI" checked={rsiCfg.enabled} onChange={(e) => updateRsi({ ...rsiCfg, enabled: e.target.checked })} />
            <span className="inline-block h-0.5 w-3" style={{ background: RSI_COLOR }} />
            <span className="text-slate-200">Relative Strength Index</span>
          </label>
          <NumField label="RSI period" text="Period" value={rsiCfg.period} min={RSI_MIN_PERIOD} max={RSI_MAX_PERIOD} integer onCommit={(v) => updateRsi({ ...rsiCfg, period: v })} />
        </div>
      )}
      {panel === "bb" && (
        <div role="dialog" aria-label="Bollinger Bands" className="mt-1 w-56 rounded border border-white/15 bg-[#10141c] p-2 shadow-lg">
          <label className="flex items-center gap-2 py-0.5">
            <input type="checkbox" aria-label="Show Bollinger Bands" checked={bbCfg.enabled} onChange={(e) => updateBb({ ...bbCfg, enabled: e.target.checked })} />
            <span className="inline-block h-0.5 w-3" style={{ background: BB_COLOR }} />
            <span className="text-slate-200">Bollinger Bands</span>
          </label>
          <NumField label="Bollinger period" text="Period" value={bbCfg.period} min={MA_MIN_PERIOD} max={MA_MAX_PERIOD} integer onCommit={(v) => updateBb({ ...bbCfg, period: v })} />
          <NumField label="Bollinger multiplier" text="Std devs" value={bbCfg.mult} min={BB_MIN_MULT} max={BB_MAX_MULT} onCommit={(v) => updateBb({ ...bbCfg, mult: v })} />
        </div>
      )}
      {panel === "ma" && (
        <div role="dialog" aria-label="Moving averages" className="mt-1 w-56 rounded border border-white/15 bg-[#10141c] p-2 shadow-lg">
          {maCfg.map((slot, i) => (
            <MaRow key={i} index={i} slot={slot} onChange={(next) => updateMa(i, next)} />
          ))}
        </div>
      )}
      </div>
    </div>
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
  const [tf, setTf] = useState(""); // chart timeframe id
  const [tfLoading, setTfLoading] = useState(false);
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

  // Timeframe: remember the choice per feed, and fetch history the first time a symbol+timeframe is shown.
  const chooseTf = useCallback((id: string) => {
    setTf(id);
    if (sourceRef.current) saveTimeframeId(sourceRef.current, id);
  }, []);
  useEffect(() => {
    const mk = market.current;
    if (!mk || !sym || !tf) return;
    if (mk.candlesFor(sym, tf).length > 0) {
      setTfLoading(false);
      return;
    }
    let cancelled = false;
    setTfLoading(true);
    mk.loadTimeframe(sym, tf)
      .then(() => !cancelled && setTick((t) => t + 1))
      .catch((e) => {
        if (cancelled) return;
        say(`Couldn't load ${tf} candles for ${sym}: ${(e as Error).message}. Showing ${mk.defaultTimeframe} instead.`, true);
        setTf(mk.defaultTimeframe);
      })
      .finally(() => !cancelled && setTfLoading(false));
    return () => {
      cancelled = true;
    };
  }, [sym, tf, say]);

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
      setTf(loadTimeframeId(src, feed.timeframes) ?? feed.defaultTimeframe);
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
    const findTf = (w?: string) =>
      mk.timeframes.find((t) => t.id.toLowerCase() === (w ?? "").toLowerCase() || t.label.toLowerCase() === (w ?? "").toLowerCase());
    const tfList = mk.timeframes.map((t) => t.label).join(" | ");
    if (cmdName === "chart" || cmdName === "go") {
      const s = known(args[0]);
      if (!s) return say("Usage: chart SYMBOL [TIMEFRAME]", true);
      if (args[1]) {
        const f = findTf(args[1]);
        if (!f) return say(`Unknown timeframe "${args[1]}". Use ${tfList}`, true);
        chooseTf(f.id);
      }
      return setSym(s);
    }
    if (cmdName === "tf" || cmdName === "timeframe") {
      const f = findTf(args[0]);
      if (!f) return say(`Usage: tf ${tfList}`, true);
      return chooseTf(f.id);
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
        "chart SYM [TF]             switch chart/ticket symbol (and timeframe)",
        "tf TIMEFRAME               chart timeframe, e.g. tf 1h",
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
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-white/10 px-4 py-2">
            <span className="text-lg font-bold">{sym}</span>
            <span className="text-lg">{fmt(m.price[sym], dp)}</span>
            <span className={pnlColor(m.changePct(sym))}>{sign(m.changePct(sym))}%</span>
            <div role="group" aria-label="Chart timeframe" className="flex items-center gap-0.5">
              {m.timeframes.map((t) => (
                <button
                  key={t.id}
                  onClick={() => chooseTf(t.id)}
                  aria-pressed={tf === t.id}
                  className={`rounded px-2 py-0.5 text-xs ${
                    tf === t.id ? "bg-white/15 text-white" : "text-slate-500 hover:bg-white/5 hover:text-slate-300"
                  }`}
                >
                  {t.label}
                </button>
              ))}
              {tfLoading && <span className="ml-2 text-[10px] text-slate-500">loading…</span>}
            </div>
            <span className="ml-auto text-xs text-slate-500">
              bid {fmt(m.bid(sym), dp)} · ask {fmt(m.ask(sym), dp)}
            </span>
          </div>
          <div className="h-[320px] lg:h-auto lg:min-h-[200px] lg:flex-[3]">
            <Chart market={m} sym={sym} tf={tf} loading={tfLoading} />
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
