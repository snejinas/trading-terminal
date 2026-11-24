import type { Page } from "@playwright/test";
import { expect, test } from "./support/test";
import { BASE_PRICES, installMockBinance } from "./support/mockBinance";
import { chartCanvas, chartMas, chartState, clickTimeframe, hoverCandle, openTerminal, reloadTerminal } from "./support/terminal";

const BASE = BASE_PRICES.BTCUSDT;
const maButton = (page: Page) => page.getByRole("button", { name: "Moving averages" });
const popover = (page: Page) => page.getByRole("dialog", { name: "Moving averages" });
const enable = (page: Page, n: number) => page.getByRole("checkbox", { name: `Show moving average ${n}` });
const type = (page: Page, n: number) => page.getByLabel(`Moving average ${n} type`);
const period = (page: Page, n: number) => page.getByLabel(`Moving average ${n} period`);
const readings = async (page: Page) => Object.fromEntries((await chartMas(page)).map((r) => [r.label, r.value]));

/**
 * Count canvas pixels close to `rgb` below the legend (y >= 50 css px), i.e. in the plot itself.
 * Candles, grid and the volume pane never use the moving-average colours.
 */
async function pixelsOfColor(page: Page, rgb: [number, number, number]): Promise<number> {
  return chartCanvas(page).evaluate(
    (el, [r0, g0, b0]) => {
      const canvas = el as HTMLCanvasElement;
      const dpr = window.devicePixelRatio || 1;
      const plotW = Math.round((canvas.clientWidth - 84) * dpr);
      const top = Math.round(50 * dpr);
      const img = canvas.getContext("2d")!.getImageData(0, top, plotW, canvas.height - top);
      let n = 0;
      for (let i = 0; i < img.data.length; i += 4) {
        if (Math.abs(img.data[i] - r0) < 30 && Math.abs(img.data[i + 1] - g0) < 30 && Math.abs(img.data[i + 2] - b0) < 30) n++;
      }
      return n;
    },
    rgb
  );
}
const AMBER: [number, number, number] = [0xf5, 0xa5, 0x24];
const VIOLET: [number, number, number] = [0xa7, 0x8b, 0xfa];

test.describe("moving averages on a rising ramp", () => {
  test.beforeEach(async ({ page, context }) => {
    await installMockBinance(context, { history: "ramp" });
    await openTerminal(page);
  });

  test("SMA 20 and SMA 50 are on by default; EMA 200 is off", async ({ page }) => {
    await expect(maButton(page)).toHaveAttribute("aria-pressed", "true");
    const r = await readings(page);
    expect(Object.keys(r)).toEqual(["SMA 20", "SMA 50"]);
    // closes are base-j+0.5 for j minutes back and the live candle closes at base, so the means are exact
    expect(r["SMA 20"]).toBeCloseTo(BASE - 9.025, 6);
    expect(r["SMA 50"]).toBeCloseTo(BASE - 24.01, 6);
  });

  test("the lines are drawn in their own colours", async ({ page }) => {
    expect(await pixelsOfColor(page, AMBER)).toBeGreaterThan(50);
    expect(await pixelsOfColor(page, VIOLET)).toBeGreaterThan(50);
  });

  test("hovering a candle shows the averages as of that candle", async ({ page }) => {
    await hoverCandle(page, 30);
    // mean of the closes 30..49 candles back is base-(m+9)=base-39; the 50-candle one is base-(m+24)
    await expect.poll(async () => (await readings(page))["SMA 20"]).toBeCloseTo(BASE - 39, 6);
    expect((await readings(page))["SMA 50"]).toBeCloseTo(BASE - 54, 6);
    await page.mouse.move(5, 5); // off the chart: back to the newest candle
    await expect.poll(async () => (await readings(page))["SMA 20"]).toBeCloseTo(BASE - 9.025, 6);
  });

  test("the legend is drawn on the canvas", async ({ page }) => {
    // legend text uses the line colours at the top of the plot (y 22..38)
    const amberInLegend = await chartCanvas(page).evaluate((el) => {
      const c = el as HTMLCanvasElement;
      const dpr = window.devicePixelRatio || 1;
      const img = c.getContext("2d")!.getImageData(0, Math.round(22 * dpr), Math.round(300 * dpr), Math.round(16 * dpr));
      let n = 0;
      for (let i = 0; i < img.data.length; i += 4) if (img.data[i] > 200 && img.data[i + 1] > 130 && img.data[i + 2] < 90) n++;
      return n;
    });
    expect(amberInLegend).toBeGreaterThan(20);
  });

  test("the popover edits an average: type, period and visibility", async ({ page }) => {
    await expect(popover(page)).toHaveCount(0);
    await maButton(page).click();
    await expect(popover(page)).toBeVisible();
    await expect(enable(page, 1)).toBeChecked();
    await expect(enable(page, 3)).not.toBeChecked();
    await expect(type(page, 3)).toHaveValue("ema");
    await expect(period(page, 3)).toHaveValue("200");

    await period(page, 2).fill("10");
    await expect.poll(async () => (await readings(page))["SMA 10"]).toBeCloseTo(BASE - 4.05, 6);
    expect((await readings(page))["SMA 50"]).toBeUndefined();

    await enable(page, 1).uncheck();
    await expect.poll(async () => Object.keys(await readings(page))).toEqual(["SMA 10"]);
    const amberBefore = await pixelsOfColor(page, AMBER);
    expect(amberBefore).toBe(0);

    await type(page, 2).selectOption("ema");
    await expect.poll(async () => Object.keys(await readings(page))).toEqual(["EMA 10"]);
    // an EMA on a rising ramp trails the price by less than 10 closes, but never catches it
    const ema = (await readings(page))["EMA 10"]!;
    expect(ema).toBeLessThan(BASE);
    expect(ema).toBeGreaterThan(BASE - 10);
  });

  test("invalid periods are ignored and the field snaps back on blur", async ({ page }) => {
    await maButton(page).click();
    for (const bad of ["0", "501", "abc", "", "2.5", "-3"]) {
      await period(page, 1).fill(bad);
      await expect(period(page, 1)).toHaveAttribute("aria-invalid", "true");
      expect(Object.keys(await readings(page))).toContain("SMA 20");
    }
    await period(page, 1).blur();
    await expect(period(page, 1)).toHaveValue("20");
    await expect(period(page, 1)).toHaveAttribute("aria-invalid", "false");

    await period(page, 1).fill("500");
    await expect.poll(async () => Object.keys(await readings(page))).toContain("SMA 500");
    await period(page, 1).fill("1");
    await expect.poll(async () => (await readings(page))["SMA 1"]).toBe(BASE); // period 1 is the close itself
  });

  test("Escape and clicking elsewhere close the popover", async ({ page }) => {
    await maButton(page).click();
    await expect(popover(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(popover(page)).toHaveCount(0);

    await maButton(page).click();
    await expect(popover(page)).toBeVisible();
    await page.mouse.click(40, 400);
    await expect(popover(page)).toHaveCount(0);
  });

  test("switching every average off clears the lines and the legend", async ({ page }) => {
    await maButton(page).click();
    await enable(page, 1).uncheck();
    await enable(page, 2).uncheck();
    await expect.poll(async () => (await chartMas(page)).length).toBe(0);
    await expect(maButton(page)).toHaveAttribute("aria-pressed", "false");
    expect(await pixelsOfColor(page, AMBER)).toBe(0);
    expect(await pixelsOfColor(page, VIOLET)).toBe(0);
  });

  test("the choice is remembered across a reload", async ({ page }) => {
    await maButton(page).click();
    await enable(page, 3).check();
    await period(page, 3).fill("100");
    await type(page, 3).selectOption("sma");
    await enable(page, 1).uncheck();
    await expect.poll(async () => Object.keys(await readings(page))).toEqual(["SMA 50", "SMA 100"]);

    await reloadTerminal(page);
    await expect.poll(async () => Object.keys(await readings(page))).toEqual(["SMA 50", "SMA 100"]);
    await maButton(page).click();
    await expect(enable(page, 1)).not.toBeChecked();
    await expect(period(page, 3)).toHaveValue("100");
  });

  test("they do not change the price scale or break zoom and scroll", async ({ page }) => {
    const before = await chartState(page);
    await chartCanvas(page).focus();
    await page.keyboard.press("Shift+ArrowLeft");
    await expect.poll(async () => (await chartState(page)).offset).toBeGreaterThan(before.offset);
    const r = await readings(page);
    expect(r["SMA 20"]).toBeLessThan(BASE - 9.025); // scrolled back: the newest visible candle is older, so lower
    await page.keyboard.press("End");
    await expect.poll(async () => (await readings(page))["SMA 20"]).toBeCloseTo(BASE - 9.025, 6);
  });
});

test("EMA 200 is seeded with the simple average of the first 200 closes", async ({ page, context }) => {
  // exactly 200 candles of history: the EMA only has its seed, which is the SMA 200
  await installMockBinance(context, { history: "ramp", historyMinutes: 199 });
  await openTerminal(page);
  await maButton(page).click();
  await enable(page, 3).check();
  await expect.poll(async () => (await readings(page))["EMA 200"]).toBeCloseTo(BASE - 99.0025, 6);
});

test("an average longer than the loaded history shows a dash instead of a value", async ({ page, context }) => {
  await installMockBinance(context, { history: "ramp", historyMinutes: 30 });
  await openTerminal(page);
  const r = await readings(page);
  expect(r["SMA 20"]).toBeCloseTo(BASE - 9.025, 6);
  expect(r["SMA 50"]).toBeNull();
  expect(await pixelsOfColor(page, VIOLET)).toBe(0); // nothing to draw for it
  expect(await pixelsOfColor(page, AMBER)).toBeGreaterThan(20);
});

test("higher timeframes get their own averages", async ({ page, context }) => {
  await installMockBinance(context, { history: "ramp" });
  await openTerminal(page);
  await clickTimeframe(page, "1h");
  await expect.poll(async () => (await readings(page))["SMA 20"]).not.toBeUndefined();
  const r = await readings(page);
  for (const v of Object.values(r)) expect(Number.isFinite(v)).toBe(true);
  expect(await pixelsOfColor(page, AMBER)).toBeGreaterThan(50);
});
