import type { Page } from "@playwright/test";
import { expect, test } from "./support/test";
import { installMockBinance } from "./support/mockBinance";
import { chartCanvas, chartRsi, chartState, clickTimeframe, hoverCandle, openTerminal, paneHeights, reloadTerminal } from "./support/terminal";

const rsiButton = (page: Page) => page.getByRole("button", { name: "RSI", exact: true });
const popover = (page: Page) => page.getByRole("dialog", { name: "RSI" });
const show = (page: Page) => page.getByRole("checkbox", { name: "Show RSI" });
const periodInput = (page: Page) => page.getByLabel("RSI period");
const PINK: [number, number, number] = [0xf4, 0x72, 0xb6];

async function pixelsOfColor(page: Page, rgb: [number, number, number]): Promise<number> {
  return chartCanvas(page).evaluate(
    (el, [r0, g0, b0]) => {
      const c = el as HTMLCanvasElement;
      const dpr = window.devicePixelRatio || 1;
      const top = Math.round(50 * dpr);
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

/** Wilder's RSI over the zigzag closes the mock serves (newest candle = k 0 closes at the base price). */
function expectedRsi(loaded: number, period: number, backFromNewest: number): number {
  const z = [0, 2, 1];
  const closes = Array.from({ length: loaded }, (_, i) => z[(((i - (loaded - 1)) % 3) + 3) % 3]);
  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    gains.push(Math.max(closes[i] - closes[i - 1], 0));
    losses.push(Math.max(closes[i - 1] - closes[i], 0));
  }
  let ag = gains.slice(0, period).reduce((a, b) => a + b) / period;
  let al = losses.slice(0, period).reduce((a, b) => a + b) / period;
  const at = loaded - 1 - backFromNewest;
  let value = 100 - 100 / (1 + ag / al); // at index `period`
  for (let j = period; j < at; j++) {
    ag = (ag * (period - 1) + gains[j]) / period;
    al = (al * (period - 1) + losses[j]) / period;
    value = 100 - 100 / (1 + ag / al);
  }
  return value;
}

test.describe("RSI on a repeating +2 / -1 / -1 price pattern", () => {
  test.beforeEach(async ({ page, context }) => {
    await installMockBinance(context, { history: "zigzag" });
    await openTerminal(page);
  });

  test("it is off by default: no pane, no pixels", async ({ page }) => {
    await expect(rsiButton(page)).toHaveAttribute("aria-pressed", "false");
    expect(await chartRsi(page)).toBeNull();
    expect((await paneHeights(page)).rsih).toBe(0);
    expect(await pixelsOfColor(page, PINK)).toBe(0);
  });

  test("turning it on opens a pane under the price chart and shrinks the price area", async ({ page }) => {
    const before = await paneHeights(page);
    await rsiButton(page).click();
    await show(page).check();
    await expect.poll(async () => (await paneHeights(page)).rsih).toBeGreaterThanOrEqual(44);
    const after = await paneHeights(page);
    expect(after.priceh).toBeLessThan(before.priceh);
    expect(after.volh).toBe(before.volh); // the volume pane is untouched
    expect((await chartState(page)).vol).toBe("1");
    expect(await pixelsOfColor(page, PINK)).toBeGreaterThan(80);
  });

  test("the newest value is the exact Wilder RSI", async ({ page }) => {
    await rsiButton(page).click();
    await show(page).check();
    await expect.poll(async () => (await chartRsi(page))?.label).toBe("RSI 14");
    const loaded = (await chartState(page)).loaded;
    const r = (await chartRsi(page))!;
    expect(r.value).toBeCloseTo(expectedRsi(loaded, 14, 0), 6);
    expect(r.value!).toBeGreaterThan(0);
    expect(r.value!).toBeLessThan(100);
  });

  test("hovering a candle shows the RSI as of that candle", async ({ page }) => {
    await rsiButton(page).click();
    await show(page).check();
    const loaded = (await chartState(page)).loaded;
    await hoverCandle(page, 25, 120);
    await expect.poll(async () => (await chartRsi(page))?.value).toBeCloseTo(expectedRsi(loaded, 14, 25), 6);
    await hoverCandle(page, 26, 120);
    await expect.poll(async () => (await chartRsi(page))?.value).toBeCloseTo(expectedRsi(loaded, 14, 26), 6);
    expect(expectedRsi(loaded, 14, 25)).not.toBeCloseTo(expectedRsi(loaded, 14, 26), 2); // the two differ
  });

  test("the period changes the value; invalid periods are ignored", async ({ page }) => {
    await rsiButton(page).click();
    await show(page).check();
    await periodInput(page).fill("5");
    await expect.poll(async () => (await chartRsi(page))?.label).toBe("RSI 5");
    const loaded = (await chartState(page)).loaded;
    await expect.poll(async () => (await chartRsi(page))?.value).toBeCloseTo(expectedRsi(loaded, 5, 0), 6);
    for (const bad of ["1", "0", "201", "abc", "", "2.5", "-4"]) {
      await periodInput(page).fill(bad);
      await expect(periodInput(page)).toHaveAttribute("aria-invalid", "true");
      expect((await chartRsi(page))?.label).toBe("RSI 5");
    }
    await periodInput(page).blur();
    await expect(periodInput(page)).toHaveValue("5");
    await periodInput(page).fill("200");
    await expect.poll(async () => (await chartRsi(page))?.label).toBe("RSI 200");
  });

  test("turning it off removes the pane and gives the space back", async ({ page }) => {
    const before = await paneHeights(page);
    await rsiButton(page).click();
    await show(page).check();
    await expect.poll(async () => (await paneHeights(page)).rsih).toBeGreaterThan(0);
    await show(page).uncheck();
    await expect.poll(async () => (await paneHeights(page)).rsih).toBe(0);
    expect((await paneHeights(page)).priceh).toBe(before.priceh);
    expect(await chartRsi(page)).toBeNull();
    expect(await pixelsOfColor(page, PINK)).toBe(0);
  });

  test("the pane coexists with the volume pane and the Vol button", async ({ page }) => {
    await rsiButton(page).click();
    await show(page).check();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Volume" }).click();
    await expect.poll(async () => (await chartState(page)).vol).toBe("0");
    const noVol = await paneHeights(page);
    expect(noVol.rsih).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Volume" }).click();
    await expect.poll(async () => (await paneHeights(page)).volh).toBeGreaterThan(0);
    expect((await paneHeights(page)).priceh).toBeLessThan(noVol.priceh); // volume takes its share back
  });

  test("the setting is remembered across a reload", async ({ page }) => {
    await rsiButton(page).click();
    await show(page).check();
    await periodInput(page).fill("9");
    await expect.poll(async () => (await chartRsi(page))?.label).toBe("RSI 9");
    await reloadTerminal(page);
    await expect.poll(async () => (await chartRsi(page))?.label).toBe("RSI 9");
    await expect(rsiButton(page)).toHaveAttribute("aria-pressed", "true");
  });

  test("the popovers are exclusive and close with Escape or an outside click", async ({ page }) => {
    await rsiButton(page).click();
    await expect(popover(page)).toBeVisible();
    await page.getByRole("button", { name: "Bollinger Bands" }).click();
    await expect(popover(page)).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "Bollinger Bands" })).toBeVisible();
    await rsiButton(page).click();
    await expect(page.getByRole("dialog", { name: "Bollinger Bands" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(popover(page)).toHaveCount(0);
    await rsiButton(page).click();
    await page.mouse.click(40, 400);
    await expect(popover(page)).toHaveCount(0);
  });

  test("it follows the timeframe and stays between 0 and 100", async ({ page }) => {
    await rsiButton(page).click();
    await show(page).check();
    await clickTimeframe(page, "1h");
    await expect.poll(async () => (await chartRsi(page))?.value).not.toBeNull();
    const v = (await chartRsi(page))!.value!;
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(100);
  });
});

test("a rising ramp reads 100 and a short history reads a dash", async ({ page, context }) => {
  await installMockBinance(context, { history: "ramp" });
  await openTerminal(page);
  await rsiButton(page).click();
  await show(page).check();
  await expect.poll(async () => (await chartRsi(page))?.value).toBe(100); // only gains
});

test("with fewer candles than the period the pane shows a dash", async ({ page, context }) => {
  await installMockBinance(context, { history: "zigzag", historyMinutes: 8 });
  await openTerminal(page);
  await rsiButton(page).click();
  await show(page).check();
  await periodInput(page).fill("14");
  await expect.poll(async () => (await chartRsi(page))?.label).toBe("RSI 14");
  expect((await chartRsi(page))!.value).toBeNull();
  expect(await pixelsOfColor(page, PINK)).toBeGreaterThan(0); // the label text is still drawn
});
