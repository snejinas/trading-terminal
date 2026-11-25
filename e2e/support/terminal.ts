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
export const paneHeights = (page: Page): Promise<{ rsih: number; priceh: number; volh: number }> =>
  chartCanvas(page).evaluate((c) => {
    const d = (c as HTMLCanvasElement).dataset;
    return { rsih: Number(d.rsih), priceh: Number(d.priceh), volh: Number(d.volh) };
  });
