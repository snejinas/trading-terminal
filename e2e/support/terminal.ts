import type { Locator, Page } from "@playwright/test";

export const COMMAND_INPUT = 'input[placeholder^="buy"]';

/** Open the terminal and give the first stream messages (book, candles) a moment to arrive. */
export async function openTerminal(page: Page): Promise<void> {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator(COMMAND_INPUT).waitFor();
  await page.waitForTimeout(1200);
}

export async function reloadTerminal(page: Page): Promise<void> {
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(COMMAND_INPUT).waitFor();
  await page.waitForTimeout(1200);
}

/** Type a command-line command and press Enter. */
export async function runCommand(page: Page, command: string, settleMs = 350): Promise<void> {
  const input = page.locator(COMMAND_INPUT);
  await input.fill(command);
  await input.press("Enter");
  await page.waitForTimeout(settleMs);
}

/** Lines of the command-line log (newest first) matching `re`. */
export async function logLines(page: Page, re: RegExp): Promise<string[]> {
  return (await page.locator("div.flex-col-reverse").innerText()).split("\n").filter((l) => re.test(l));
}

export const headerText = async (page: Page): Promise<string> => (await page.locator("header").innerText()).replace(/\n/g, " ");
export const cashText = async (page: Page): Promise<string> => (await headerText(page)).match(/CASH \$([\d,.]+)/)![1];

// ── chart ──

export const chartCanvas = (page: Page): Locator => page.locator("canvas[role=application]");
export const timeframeGroup = (page: Page): Locator => page.getByRole("group", { name: "Chart timeframe" });

export interface ChartState {
  offset: number;
  count: number;
  loaded: number;
  start: number;
  vol: string;
  volh: number;
  maxv: number | null;
}

/** The chart exposes its viewport on the canvas's data-* attributes. */
export const chartState = (page: Page): Promise<ChartState> =>
  chartCanvas(page).evaluate((c) => {
    const d = (c as HTMLCanvasElement).dataset;
    return {
      offset: Number(d.offset),
      count: Number(d.count),
      loaded: Number(d.loaded),
      start: Number(d.start),
      vol: d.vol ?? "",
      volh: Number(d.volh),
      maxv: d.maxv ? Number(d.maxv) : null,
    };
  });

/** Visible candles at the default zoom for this viewport. */
export async function defaultCandleCount(page: Page): Promise<number> {
  const box = (await chartCanvas(page).boundingBox())!;
  const plotW = box.width - 84; // 72px price axis + 12px padding
  return Math.min(90, Math.max(20, Math.floor(plotW / 8)));
}

export async function pressedTimeframes(page: Page): Promise<string> {
  return (
    await timeframeGroup(page)
      .getByRole("button")
      .evaluateAll((bs) => bs.filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.textContent))
  ).join(",");
}

export const clickTimeframe = (page: Page, label: string) =>
  timeframeGroup(page).getByRole("button", { name: label, exact: true }).click();

export interface MaReading {
  label: string;
  value: number | null;
}

/** The moving-average legend as drawn: value under the cursor if hovering, else at the newest visible candle. */
export const chartMas = (page: Page): Promise<MaReading[]> =>
  chartCanvas(page).evaluate((c) => JSON.parse((c as HTMLCanvasElement).dataset.ma ?? "[]"));

/** Move the mouse over the candle `back` candles before the newest one (only valid while at the live edge). */
export async function hoverCandle(page: Page, back: number, y = 140): Promise<void> {
  const box = (await chartCanvas(page).boundingBox())!;
  const s = await chartState(page);
  const step = (box.width - 84) / s.count;
  await page.mouse.move(box.x + (s.loaded - 1 - back - s.start + 0.5) * step, box.y + y);
}

export interface BbReading {
  label: string;
  upper: number | null;
  mid: number | null;
  lower: number | null;
}

/** The Bollinger legend as drawn (null while the bands are off). */
export const chartBb = (page: Page): Promise<BbReading | null> =>
  chartCanvas(page).evaluate((c) => {
    const s = (c as HTMLCanvasElement).dataset.bb;
    return s ? JSON.parse(s) : null;
  });

export interface RsiReading {
  label: string;
  value: number | null;
}

/** The RSI pane's label as drawn (null while the pane is off). */
export const chartRsi = (page: Page): Promise<RsiReading | null> =>
  chartCanvas(page).evaluate((c) => {
    const s = (c as HTMLCanvasElement).dataset.rsi;
    return s ? JSON.parse(s) : null;
  });

/** Heights (css px) of the RSI pane and of the price pane above it. */
export const paneHeights = (page: Page): Promise<{ rsih: number; stochh: number; priceh: number; volh: number }> =>
  chartCanvas(page).evaluate((c) => {
    const d = (c as HTMLCanvasElement).dataset;
    return { rsih: Number(d.rsih), stochh: Number(d.stochh), priceh: Number(d.priceh), volh: Number(d.volh) };
  });

export interface StochReading {
  label: string;
  k: number | null;
  d: number | null;
}

/** The Stochastic pane's label as drawn (null while the pane is off). */
export const chartStoch = (page: Page): Promise<StochReading | null> =>
  chartCanvas(page).evaluate((c) => {
    const s = (c as HTMLCanvasElement).dataset.stoch;
    return s ? JSON.parse(s) : null;
  });

export interface FibLevel {
  r: number;
  price: number;
  y: number;
}
export interface FibItem {
  id: string;
  a: { t: number; p: number };
  b: { t: number; p: number };
  ax: number;
  ay: number;
  bx: number;
  by: number;
  levels: FibLevel[];
}
export interface FibState {
  step: number;
  ext: boolean;
  items: FibItem[];
}

/** The Fibonacci retracements as drawn (positions in canvas css pixels). */
export const chartFib = (page: Page): Promise<FibState> =>
  chartCanvas(page).evaluate((c) => JSON.parse((c as HTMLCanvasElement).dataset.fib || '{"step":0,"ext":false,"items":[]}'));

/** The price scale of the price pane: price <-> canvas y. */
export async function priceScale(page: Page) {
  const d = await chartCanvas(page).evaluate((c) => {
    const ds = (c as HTMLCanvasElement).dataset;
    return { hi: Number(ds.hi), lo: Number(ds.lo), priceh: Number(ds.priceh) };
  });
  const pad = 12;
  return {
    ...d,
    yOf: (p: number) => pad + ((d.hi - p) / (d.hi - d.lo)) * (d.priceh - pad),
    priceOf: (y: number) => d.hi - ((y - pad) / (d.priceh - pad)) * (d.hi - d.lo),
    perPixel: (d.hi - d.lo) / (d.priceh - pad),
  };
}

/** Page coordinates of a candle (`back` candles before the newest) at a price. */
export async function pointAt(page: Page, back: number, price: number): Promise<{ x: number; y: number }> {
  const box = (await chartCanvas(page).boundingBox())!;
  const s = await chartState(page);
  const sc = await priceScale(page);
  const step = (box.width - 84) / s.count;
  return { x: box.x + (s.loaded - 1 - back - s.start + 0.5) * step, y: box.y + sc.yOf(price) };
}

/** RGB of the canvas pixel at a css position inside the canvas. */
export const pixelAt = (page: Page, x: number, y: number): Promise<[number, number, number]> =>
  chartCanvas(page).evaluate(
    (el, [px, py]) => {
      const c = el as HTMLCanvasElement;
      const dpr = window.devicePixelRatio || 1;
      const d = c.getContext("2d")!.getImageData(Math.round(px * dpr), Math.round(py * dpr), 1, 1).data;
      return [d[0], d[1], d[2]] as [number, number, number];
    },
    [x, y]
  );

export interface LiqSegment {
  side: "long" | "short";
  lev: number;
  price: number;
  amount: number;
  fromT: number;
  toT: number | null;
}
export interface LiqState {
  mode: "oi" | "volume";
  rows: number;
  cols: number;
  group: number;
  max: number;
  segments: number;
  hover: { price: number; pct: number } | null;
  top: LiqSegment[];
}

/** The liquidation heatmap's model state (null while it is off). */
export const chartLiq = (page: Page): Promise<LiqState | null> =>
  chartCanvas(page).evaluate((c) => {
    const s = (c as HTMLCanvasElement).dataset.liq;
    return s ? JSON.parse(s) : null;
  });

/**
 * Canvas pixels in the price pane that are blue / purple / teal (the cold half of the heat ramp). Candles are green or
 * red, text is grey and the background is near black, so this is ~0 without a heatmap. Compare on versus off rather
 * than expecting exact numbers.
 */
export const heatPixels = (page: Page): Promise<number> =>
  chartCanvas(page).evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const dpr = window.devicePixelRatio || 1;
    const h = Math.round(Number(c.dataset.priceh) * dpr);
    const w = Math.round((c.clientWidth - 84) * dpr);
    const d = c.getContext("2d")!.getImageData(0, Math.round(14 * dpr), w, h - Math.round(40 * dpr)).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 2] > 60 && d[i + 2] > d[i] + 30 && d[i + 2] >= d[i + 1] - 5) n++;
    return n;
  });
