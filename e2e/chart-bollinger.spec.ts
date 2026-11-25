import type { Page } from "@playwright/test";
import { expect, test } from "./support/test";
import { BASE_PRICES, installMockBinance } from "./support/mockBinance";
import { chartBb, chartCanvas, clickTimeframe, hoverCandle, openTerminal, reloadTerminal } from "./support/terminal";

const BASE = BASE_PRICES.BTCUSDT;
const bbButton = (page: Page) => page.getByRole("button", { name: "Bollinger Bands" });
const popover = (page: Page) => page.getByRole("dialog", { name: "Bollinger Bands" });
const show = (page: Page) => page.getByRole("checkbox", { name: "Show Bollinger Bands" });
const periodInput = (page: Page) => page.getByLabel("Bollinger period");
const multInput = (page: Page) => page.getByLabel("Bollinger multiplier");
const TEAL: [number, number, number] = [0x64, 0xd2, 0xc8];

/** Pixels near `rgb` in the plot below the legend rows (y >= 70 css px). */
async function pixelsOfColor(page: Page, rgb: [number, number, number]): Promise<number> {
  return chartCanvas(page).evaluate(
    (el, [r0, g0, b0]) => {
      const c = el as HTMLCanvasElement;
      const dpr = window.devicePixelRatio || 1;
      const top = Math.round(70 * dpr);
      const img = c.getContext("2d")!.getImageData(0, top, Math.round((c.clientWidth - 84) * dpr), c.height - top);
      let n = 0;
      for (let i = 0; i < img.data.length; i += 4) {
        if (Math.abs(img.data[i] - r0) < 30 && Math.abs(img.data[i + 1] - g0) < 30 && Math.abs(img.data[i + 2] - b0) < 30) n++;
      }
      return n;
    },
    rgb
  );
}

// on the ramp, j candles back closes at BASE-j+0.5, except the live candle (BASE); 20 consecutive
// integers have population standard deviation sqrt((20^2-1)/12)
const SD20 = Math.sqrt((400 - 1) / 12);

test.describe("Bollinger Bands on a rising ramp", () => {
  test.beforeEach(async ({ page, context }) => {
    await installMockBinance(context, { history: "ramp" });
    await openTerminal(page);
  });

  test("they are off by default and draw nothing", async ({ page }) => {
    await expect(bbButton(page)).toHaveAttribute("aria-pressed", "false");
    expect(await chartBb(page)).toBeNull();
    expect(await pixelsOfColor(page, TEAL)).toBe(0);
  });

  test("turning them on shows exact bands in the legend and draws them", async ({ page }) => {
    await bbButton(page).click();
    await show(page).check();
    // the window ending at the live candle: closes BASE, BASE-0.5, BASE-1.5 ... BASE-18.5
    const closes = [BASE, ...Array.from({ length: 19 }, (_, i) => BASE - (i + 1) + 0.5)];
    const mean = closes.reduce((a, b) => a + b) / 20;
    const sd = Math.sqrt(closes.reduce((a, b) => a + (b - mean) ** 2, 0) / 20);
    await expect.poll(async () => (await chartBb(page))?.mid).toBeCloseTo(mean, 6);
    const r = (await chartBb(page))!;
    expect(r.label).toBe("BB 20,2");
    expect(r.upper).toBeCloseTo(mean + 2 * sd, 6);
    expect(r.lower).toBeCloseTo(mean - 2 * sd, 6);
    expect(await pixelsOfColor(page, TEAL)).toBeGreaterThan(100);
  });

  test("hovering reports the bands as of that candle", async ({ page }) => {
    await bbButton(page).click();
    await show(page).check();
    await hoverCandle(page, 30, 200);
    // 30..49 candles back is a clean ramp: mean BASE-39, so upper/lower are 2 deviations either side
    await expect.poll(async () => (await chartBb(page))?.mid).toBeCloseTo(BASE - 39, 6);
    const r = (await chartBb(page))!;
    expect(r.upper).toBeCloseTo(BASE - 39 + 2 * SD20, 6);
    expect(r.lower).toBeCloseTo(BASE - 39 - 2 * SD20, 6);
  });

  test("period and multiplier change the bands; bad input is ignored", async ({ page }) => {
    await bbButton(page).click();
    await show(page).check();
    await multInput(page).fill("1");
    await expect.poll(async () => (await chartBb(page))?.label).toBe("BB 20,1");
    await hoverCandle(page, 30, 200);
    await expect.poll(async () => (await chartBb(page))?.upper).toBeCloseTo(BASE - 39 + SD20, 6);

    await multInput(page).fill("1.5");
    await expect.poll(async () => (await chartBb(page))?.label).toBe("BB 20,1.5");

    for (const bad of ["0", "11", "abc", "", "-1", "0.05"]) {
      await multInput(page).fill(bad);
      await expect(multInput(page)).toHaveAttribute("aria-invalid", "true");
      expect((await chartBb(page))?.label).toBe("BB 20,1.5");
    }
    await multInput(page).blur();
    await expect(multInput(page)).toHaveValue("1.5");

    for (const bad of ["0", "501", "2.5", "x"]) {
      await periodInput(page).fill(bad);
      await expect(periodInput(page)).toHaveAttribute("aria-invalid", "true");
    }
    await periodInput(page).fill("10");
    await expect.poll(async () => (await chartBb(page))?.label).toBe("BB 10,1.5");
    // 10 consecutive integers: sd = sqrt((100-1)/12)
    await hoverCandle(page, 30, 200);
    await expect.poll(async () => (await chartBb(page))?.mid).toBeCloseTo(BASE - 30 - 4, 6);
    expect((await chartBb(page))!.upper).toBeCloseTo(BASE - 34 + 1.5 * Math.sqrt(99 / 12), 6);
  });

  test("turning them off clears the legend and the lines", async ({ page }) => {
    await bbButton(page).click();
    await show(page).check();
    await expect.poll(() => pixelsOfColor(page, TEAL)).toBeGreaterThan(100);
    await show(page).uncheck();
    await expect.poll(() => chartBb(page)).toBeNull();
    expect(await pixelsOfColor(page, TEAL)).toBe(0);
    await expect(bbButton(page)).toHaveAttribute("aria-pressed", "false");
  });

  test("the setting is remembered across a reload", async ({ page }) => {
    await bbButton(page).click();
    await show(page).check();
    await periodInput(page).fill("30");
    await multInput(page).fill("2.5");
    await expect.poll(async () => (await chartBb(page))?.label).toBe("BB 30,2.5");
    await reloadTerminal(page);
    await expect.poll(async () => (await chartBb(page))?.label).toBe("BB 30,2.5");
    await expect(bbButton(page)).toHaveAttribute("aria-pressed", "true");
  });

  test("the two popovers are exclusive, and Escape or an outside click closes them", async ({ page }) => {
    const ma = page.getByRole("dialog", { name: "Moving averages" });
    await page.getByRole("button", { name: "Moving averages" }).click();
    await expect(ma).toBeVisible();
    await bbButton(page).click();
    await expect(popover(page)).toBeVisible();
    await expect(ma).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(popover(page)).toHaveCount(0);
    await bbButton(page).click();
    await page.mouse.click(40, 400);
    await expect(popover(page)).toHaveCount(0);
  });

  test("they work together with the moving averages and on higher timeframes", async ({ page }) => {
    await bbButton(page).click();
    await show(page).check();
    await clickTimeframe(page, "1h");
    await expect.poll(async () => (await chartBb(page))?.upper).not.toBeNull();
    const r = (await chartBb(page))!;
    expect(r.upper!).toBeGreaterThan(r.mid!);
    expect(r.mid!).toBeGreaterThan(r.lower!);
    expect(await pixelsOfColor(page, TEAL)).toBeGreaterThan(100);
  });
});

test("with less history than the period the legend shows dashes and nothing is drawn", async ({ page, context }) => {
  await installMockBinance(context, { history: "ramp", historyMinutes: 10 });
  await openTerminal(page);
  await bbButton(page).click();
  await show(page).check();
  await expect.poll(async () => (await chartBb(page))?.label).toBe("BB 20,2");
  expect(await chartBb(page)).toMatchObject({ upper: null, mid: null, lower: null });
  expect(await pixelsOfColor(page, TEAL)).toBe(0);
});
