import type { Page } from "@playwright/test";
import { expect, test } from "./support/test";
import { BASE_PRICES, blockBinance, installMockBinance } from "./support/mockBinance";
import { chartCanvas, chartState, chartVp, clickTimeframe, heatPixels, openTerminal, paneHeights, reloadTerminal, type VpState } from "./support/terminal";

const BASE = BASE_PRICES.BTCUSDT;
const button = (page: Page) => page.getByRole("button", { name: "Volume profile", exact: true });
const popover = (page: Page) => page.getByRole("dialog", { name: "Volume profile" });
const show = (page: Page) => page.getByRole("checkbox", { name: "Show volume profile" });
const rowsInput = (page: Page) => page.getByLabel("Volume profile rows");
const vaInput = (page: Page) => page.getByLabel("Value area percent");
const SPIKE_BACK = 50;

/**
 * The mock's ramp history: the candle b minutes back spans BASE-b-1 .. BASE-b+1 and trades 10 (100 in the spike candle).
 * Independent reference for the profile over the candles first..last (indices into the loaded series).
 */
function expectedBins(vp: VpState, loaded: number): number[] {
  const bw = (vp.hi - vp.lo) / vp.rows;
  const bins = new Array(vp.rows).fill(0);
  for (let idx = vp.first; idx <= vp.last; idx++) {
    const b = loaded - 1 - idx;
    const l = BASE - b - 1;
    const h = BASE - b + 1;
    const v = b === SPIKE_BACK ? 100 : 10;
    for (let r = 0; r < vp.rows; r++) {
      const top = vp.hi - r * bw;
      const overlap = Math.min(h, top) - Math.max(l, top - bw);
      if (overlap > 0) bins[r] += (v * overlap) / (h - l);
    }
  }
  return bins;
}

/** Turn it on and scroll back a little so the live candle (which the stream rewrites) is not in the window. */
async function open(page: Page) {
  await button(page).click();
  await show(page).check();
  await page.keyboard.press("Escape");
  await expect(popover(page)).toHaveCount(0);
  await chartCanvas(page).focus();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(async () => (await chartState(page)).offset).toBeGreaterThan(0);
}

test.describe("volume profile on a rising ramp with one heavy candle", () => {
  test.beforeEach(async ({ page, context }) => {
    await installMockBinance(context, { history: "ramp", spikeMinutesAgo: SPIKE_BACK });
    await openTerminal(page);
  });

  test("it is off by default", async ({ page }) => {
    await expect(button(page)).toHaveAttribute("aria-pressed", "false");
    expect(await chartVp(page)).toBeNull();
  });

  test("turning it on draws bars behind the candles", async ({ page }) => {
    const off = await heatPixels(page); // counts blue/purple pixels, which the profile bars are
    await button(page).click();
    await show(page).check();
    await expect.poll(async () => (await chartVp(page))?.rows).toBe(48);
    const vp = (await chartVp(page))!;
    expect(vp.total).toBeGreaterThan(0);
    expect(vp.bins).toHaveLength(48);
    expect(await heatPixels(page)).toBeGreaterThan(off + 1500);
    await expect(button(page)).toHaveAttribute("aria-pressed", "true");
  });

  test("every level's volume matches an independent calculation", async ({ page }) => {
    await open(page);
    const vp = (await chartVp(page))!;
    const loaded = (await chartState(page)).loaded;
    const want = expectedBins(vp, loaded);
    vp.bins.forEach((x, r) => expect(x, `level ${r}`).toBeCloseTo(want[r], 6));
    expect(vp.total).toBeCloseTo(want.reduce((a, b) => a + b, 0), 6);
    // every candle in the window is accounted for: 10 each, plus 90 extra if the heavy one is in view
    const candles = vp.last - vp.first + 1;
    const spikeIn = loaded - 1 - SPIKE_BACK >= vp.first && loaded - 1 - SPIKE_BACK <= vp.last;
    expect(vp.total).toBeCloseTo(candles * 10 + (spikeIn ? 90 : 0), 6);
    expect(spikeIn).toBe(true);
  });

  test("the point of control is the heavy candle's price", async ({ page }) => {
    await open(page);
    const vp = (await chartVp(page))!;
    const bw = (vp.hi - vp.lo) / vp.rows;
    expect(vp.poc!.volume).toBeCloseTo(Math.max(...vp.bins), 9);
    expect(vp.poc!.price).toBeGreaterThan(BASE - SPIKE_BACK - 1 - bw);
    expect(vp.poc!.price).toBeLessThan(BASE - SPIKE_BACK + 1 + bw);
    expect(vp.bins[vp.poc!.row]).toBe(vp.poc!.volume);
  });

  test("the value area holds at least 70% around the point of control", async ({ page }) => {
    await open(page);
    const vp = (await chartVp(page))!;
    const va = vp.va!;
    expect(va.percent).toBe(70);
    expect(va.vahRow).toBeLessThanOrEqual(vp.poc!.row);
    expect(va.valRow).toBeGreaterThanOrEqual(vp.poc!.row);
    expect(va.vah).toBeGreaterThan(va.val);
    const sum = vp.bins.slice(va.vahRow, va.valRow + 1).reduce((a, b) => a + b, 0);
    expect(va.volume).toBeCloseTo(sum, 6);
    expect(va.volume).toBeGreaterThanOrEqual(0.7 * vp.total - 1e-6);
    expect(va.volume).toBeLessThan(1.0 * vp.total); // not simply everything
    const bw = (vp.hi - vp.lo) / vp.rows;
    expect(va.vah).toBeCloseTo(vp.hi - va.vahRow * bw, 6);
    expect(va.val).toBeCloseTo(vp.hi - (va.valRow + 1) * bw, 6);
  });

  test("the number of levels and the value-area percentage are settings; bad input is ignored", async ({ page }) => {
    await button(page).click();
    await show(page).check();
    await rowsInput(page).fill("20");
    await expect.poll(async () => (await chartVp(page))?.rows).toBe(20);
    await vaInput(page).fill("90");
    await expect.poll(async () => (await chartVp(page))?.va?.percent).toBe(90);
    const vp = (await chartVp(page))!;
    expect(vp.va!.volume).toBeGreaterThanOrEqual(0.9 * vp.total - 1e-6);

    for (const bad of ["9", "201", "x", "", "30.5"]) {
      await rowsInput(page).fill(bad);
      await expect(rowsInput(page)).toHaveAttribute("aria-invalid", "true");
      expect((await chartVp(page))?.rows).toBe(20);
    }
    for (const bad of ["49", "96", "z", ""]) {
      await vaInput(page).fill(bad);
      await expect(vaInput(page)).toHaveAttribute("aria-invalid", "true");
      expect((await chartVp(page))?.va?.percent).toBe(90);
    }
    await rowsInput(page).blur();
    await vaInput(page).blur();
    await expect(rowsInput(page)).toHaveValue("20");
    await expect(vaInput(page)).toHaveValue("90");
    await rowsInput(page).fill("200");
    await expect.poll(async () => (await chartVp(page))?.rows).toBe(200);
  });

  test("it follows scrolling and zooming: always the candles in view", async ({ page }) => {
    await open(page);
    const a = (await chartVp(page))!;
    await page.keyboard.press("Shift+ArrowLeft");
    await expect.poll(async () => (await chartVp(page))?.first).not.toBe(a.first);
    const b = (await chartVp(page))!;
    const loaded = (await chartState(page)).loaded;
    expectedBins(b, loaded).forEach((x, r) => expect(b.bins[r], `after scroll, level ${r}`).toBeCloseTo(x, 6));

    for (let i = 0; i < 3; i++) await page.keyboard.press("+");
    await expect.poll(async () => (await chartState(page)).count).toBeLessThan(90);
    const c = (await chartVp(page))!;
    expect(c.last - c.first).toBeLessThan(b.last - b.first);
    expectedBins(c, loaded).forEach((x, r) => expect(c.bins[r], `after zoom, level ${r}`).toBeCloseTo(x, 6));
  });

  test("hovering reads the volume of the level under the cursor", async ({ page }) => {
    await open(page);
    const box = (await chartCanvas(page).boundingBox())!;
    const vp0 = (await chartVp(page))!;
    const priceh = (await paneHeights(page)).priceh;
    for (const y of [80, 150, 230]) {
      await page.mouse.move(box.x + 300, box.y + y);
      await expect.poll(async () => (await chartVp(page))?.hover).not.toBeNull();
      const h = (await chartVp(page))!.hover!;
      expect(h.row).toBe(Math.min(vp0.rows - 1, Math.floor((y - 12) / ((priceh - 12) / vp0.rows))));
      expect(h.volume).toBe(vp0.bins[h.row]);
    }
  });

  test("the settings are remembered across a reload", async ({ page }) => {
    await button(page).click();
    await show(page).check();
    await rowsInput(page).fill("30");
    await vaInput(page).fill("80");
    await expect.poll(async () => (await chartVp(page))?.va?.percent).toBe(80);
    await reloadTerminal(page);
    await expect.poll(async () => (await chartVp(page))?.rows).toBe(30);
    expect((await chartVp(page))!.va!.percent).toBe(80);
    await button(page).click();
    await show(page).uncheck();
    await expect.poll(() => chartVp(page)).toBeNull();
    await reloadTerminal(page);
    expect(await chartVp(page)).toBeNull();
  });

  test("it works on a higher timeframe and next to the other overlays", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: "Liquidation heatmap" }).click();
    await page.getByRole("button", { name: "Stochastic RSI", exact: true }).click();
    await page.getByRole("checkbox", { name: "Show Stochastic RSI" }).check();
    await page.keyboard.press("Escape");
    await expect.poll(async () => (await chartVp(page))?.total).toBeGreaterThan(0);
    await clickTimeframe(page, "1h");
    await expect.poll(async () => (await chartVp(page))?.total).toBeGreaterThan(0);
    expect((await chartVp(page))!.va).not.toBeNull();
  });

  test("the indicator popovers are exclusive and close with Escape or an outside click", async ({ page }) => {
    const names = ["Moving averages", "Bollinger Bands", "Volume profile", "Stochastic RSI", "Fibonacci retracement"];
    for (let i = 0; i < names.length; i++) {
      await page.getByRole("button", { name: names[i], exact: true }).click();
      for (let j = 0; j < names.length; j++) await expect(page.getByRole("dialog", { name: names[j], exact: true })).toHaveCount(i === j ? 1 : 0);
    }
    await page.keyboard.press("Escape");
    await expect(popover(page)).toHaveCount(0);
    await button(page).click();
    await page.mouse.click(40, 400);
    await expect(popover(page)).toHaveCount(0);
  });
});

test("a feed without volume says so and draws nothing", async ({ page, context }) => {
  await installMockBinance(context, { history: "ramp", volume: false });
  await openTerminal(page);
  const off = await heatPixels(page);
  await button(page).click();
  await show(page).check();
  await expect.poll(async () => (await chartVp(page))?.total).toBe(0);
  const vp = (await chartVp(page))!;
  expect(vp.poc).toBeNull();
  expect(vp.va).toBeNull();
  expect(Math.abs((await heatPixels(page)) - off)).toBeLessThan(100);
});

test("the simulated feed (Binance unreachable) has a volume profile too", async ({ page, context }) => {
  await blockBinance(context);
  await openTerminal(page);
  await button(page).click();
  await show(page).check();
  await expect.poll(async () => (await chartVp(page))?.total).toBeGreaterThan(0);
  expect((await chartVp(page))!.poc).not.toBeNull();
});
