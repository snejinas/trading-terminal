import type { Page } from "@playwright/test";
import { expect, test } from "./support/test";
import { blockBinance, installMockBinance } from "./support/mockBinance";
import { chartCanvas, chartState, clickTimeframe, openTerminal, reloadTerminal } from "./support/terminal";

const volumeButton = (page: Page) => page.getByRole("button", { name: "Volume", exact: true });
const maxVolume = (page: Page) => expect.poll(async () => (await chartState(page)).maxv);

/**
 * Height in pixels of the volume bar in every canvas column of the volume pane. Volume bars are drawn
 * in softened candle colours, which the price candles (bright) never use, so this measures only bars.
 */
async function volumeBarHeights(page: Page): Promise<number[]> {
  return chartCanvas(page).evaluate((el) => {
    const canvas = el as HTMLCanvasElement;
    const dpr = window.devicePixelRatio || 1;
    const volh = Number(canvas.dataset.volh);
    if (!volh) return [];
    const plotW = canvas.clientWidth - 84;
    const plotH = canvas.clientHeight - 24;
    const top = Math.round((plotH - volh + 4) * dpr);
    const bottom = Math.round(plotH * dpr);
    const img = canvas.getContext("2d")!.getImageData(0, top, Math.round(plotW * dpr), bottom - top);
    const heights: number[] = [];
    for (let x = 0; x < img.width; x++) {
      for (let y = 0; y < img.height; y++) {
        const i = (y * img.width + x) * 4;
        const [r, g, b] = [img.data[i], img.data[i + 1], img.data[i + 2]];
        if ((g > r + 25 && g > b + 25) || (r > g + 40 && r > b + 40)) {
          heights.push(img.height - y);
          break;
        }
      }
    }
    return heights;
  });
}

test.describe("with a volume spike 50 candles back", () => {
  test.beforeEach(async ({ page, context }) => {
    // every minute trades 10, the spike minute 100
    await installMockBinance(context, { spikeMinutesAgo: 50 });
    await openTerminal(page);
  });

  test("the volume pane is on by default, scaled to the tallest visible bar", async ({ page }) => {
    const s = await chartState(page);
    expect(s.vol).toBe("1");
    expect(s.volh).toBeGreaterThanOrEqual(36);
    expect(s.maxv).toBe(100); // the spike is inside the default window
    await expect(volumeButton(page)).toHaveAttribute("aria-pressed", "true");
  });

  test("bars are drawn in proportion to volume (the spike is 10x a normal minute)", async ({ page }) => {
    const heights = await volumeBarHeights(page);
    expect(heights.length, "columns that contain a bar").toBeGreaterThanOrEqual(80);

    const sorted = [...heights].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const tallest = sorted.at(-1)!;
    // normal minutes are 10% of the spike: 5px against 50px, i.e. a ratio of 10 (allowing for pixel rounding)
    expect(tallest / median).toBeGreaterThanOrEqual(8.5);
    expect(tallest / median).toBeLessThanOrEqual(11.5);
    // only the spike is tall (a bar is a few pixels wide, so a handful of columns)
    expect(sorted.filter((h) => h > tallest * 0.5).length).toBeLessThanOrEqual(12);
  });

  test("the scale re-fits to whatever is visible as you zoom and scroll", async ({ page }) => {
    await chartCanvas(page).focus();
    for (let i = 0; i < 6; i++) await page.keyboard.press("+"); // zoom in past the spike
    await expect.poll(async () => (await chartState(page)).count).toBeLessThan(50);
    await maxVolume(page).toBe(10); // only normal minutes are on screen now

    await page.keyboard.press("Shift+ArrowLeft"); // scroll back until the spike is visible again
    await page.keyboard.press("Shift+ArrowLeft");
    await maxVolume(page).toBe(100);
  });

  test("the Vol button hides and shows the pane, and the choice is remembered", async ({ page }) => {
    await volumeButton(page).click();
    await expect.poll(() => chartState(page)).toMatchObject({ vol: "0", volh: 0, maxv: null });
    await expect(volumeButton(page)).toHaveAttribute("aria-pressed", "false");

    await reloadTerminal(page);
    await expect.poll(async () => (await chartState(page)).vol).toBe("0");

    await volumeButton(page).click();
    await expect.poll(async () => (await chartState(page)).vol).toBe("1");
    await reloadTerminal(page);
    await expect.poll(async () => (await chartState(page)).vol).toBe("1");
  });

  test("higher timeframes show their own (summed) volumes", async ({ page }) => {
    // each 1m candle trades 10, so a bucket trades 10 x minutes, plus 90 extra in the spike's bucket
    for (const [timeframe, expected] of [
      ["5m", 50 + 90],
      ["1h", 600 + 90],
      ["1D", 14400 + 90],
    ] as const) {
      await clickTimeframe(page, timeframe);
      await expect.poll(async () => (await chartState(page)).maxv, { message: timeframe }).toBeCloseTo(expected, 3);
      expect((await chartState(page)).vol).toBe("1");
    }
  });
});

test("a feed without volume draws no volume pane at all", async ({ page, context }) => {
  await installMockBinance(context, { volume: false });
  await openTerminal(page);
  expect(await chartState(page)).toMatchObject({ vol: "0", volh: 0, maxv: null });
  expect((await chartState(page)).count).toBeGreaterThanOrEqual(20); // the chart itself is fine
});

test("the simulated feed (Binance unreachable) has volume too", async ({ page, context }) => {
  await blockBinance(context);
  await openTerminal(page);
  const s = await chartState(page);
  expect(s.vol).toBe("1");
  expect(s.maxv).toBeGreaterThan(0);
  expect((await volumeBarHeights(page)).length).toBeGreaterThanOrEqual(40);

  await clickTimeframe(page, "5m");
  await expect.poll(async () => (await chartState(page)).maxv).toBeGreaterThan(0);
  expect((await chartState(page)).vol).toBe("1");
});
