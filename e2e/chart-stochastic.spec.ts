import type { Page } from "@playwright/test";
import { expect, test } from "./support/test";
import { BASE_PRICES, installMockBinance } from "./support/mockBinance";
import { chartCanvas, chartState, chartStoch, hoverCandle, openTerminal, paneHeights, reloadTerminal, clickTimeframe } from "./support/terminal";

const BASE = BASE_PRICES.BTCUSDT;
const stochButton = (page: Page) => page.getByRole("button", { name: "Stochastic", exact: true });
const popover = (page: Page) => page.getByRole("dialog", { name: "Stochastic" });
const show = (page: Page) => page.getByRole("checkbox", { name: "Show Stochastic" });
const kPeriod = (page: Page) => page.getByLabel("Stochastic K period");
const kSmooth = (page: Page) => page.getByLabel("Stochastic K smoothing");
const dPeriod = (page: Page) => page.getByLabel("Stochastic D period");
const CYAN: [number, number, number] = [0x22, 0xd3, 0xee];
const FUCHSIA: [number, number, number] = [0xe8, 0x79, 0xf9];

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

/**
 * The mock's 1-minute closes repeat base+[0,2,1] every three minutes (high = close+1, low = close-1), so any
 * 14-candle window that does not touch the live candle spans base-1 .. base+3 and the raw %K is exactly
 * 25 / 75 / 50 for closes base / base+2 / base+1. Three consecutive raw values always average 50.
 */
const rawK = (back: number) => ({ 0: 25, 2: 75, 1: 50 })[[0, 2, 1][(((-back) % 3) + 3) % 3] as 0 | 1 | 2];

async function setup(page: Page, k: number, smooth: number, d: number) {
  await stochButton(page).click();
  await show(page).check();
  await kPeriod(page).fill(String(k));
  await kSmooth(page).fill(String(smooth));
  await dPeriod(page).fill(String(d));
  await expect.poll(async () => (await chartStoch(page))?.label).toBe(`Stoch ${k},${smooth},${d}`);
  await page.keyboard.press("Escape"); // the popover would otherwise sit on top of the candles being hovered
  await expect(popover(page)).toHaveCount(0);
}

test.describe("Stochastic on a repeating +2 / -1 / -1 price pattern", () => {
  test.beforeEach(async ({ page, context }) => {
    await installMockBinance(context, { history: "zigzag" });
    await openTerminal(page);
  });

  test("it is off by default: no pane, no pixels", async ({ page }) => {
    await expect(stochButton(page)).toHaveAttribute("aria-pressed", "false");
    expect(await chartStoch(page)).toBeNull();
    expect((await paneHeights(page)).stochh).toBe(0);
    expect(await pixelsOfColor(page, CYAN)).toBe(0);
    expect(await pixelsOfColor(page, FUCHSIA)).toBe(0);
  });

  test("turning it on opens a pane and draws both lines", async ({ page }) => {
    const before = await paneHeights(page);
    await stochButton(page).click();
    await show(page).check();
    await expect.poll(async () => (await paneHeights(page)).stochh).toBeGreaterThanOrEqual(44);
    const after = await paneHeights(page);
    expect(after.priceh).toBeLessThan(before.priceh);
    expect(after.volh).toBe(before.volh);
    expect(after.rsih).toBe(0);
    expect(await chartStoch(page)).toMatchObject({ label: "Stoch 14,3,3" });
    expect(await pixelsOfColor(page, CYAN)).toBeGreaterThan(60);
    expect(await pixelsOfColor(page, FUCHSIA)).toBeGreaterThan(60);
  });

  test("the usual 14,3,3 settings average the pattern to exactly 50", async ({ page }) => {
    await stochButton(page).click();
    await show(page).check();
    await page.keyboard.press("Escape");
    await hoverCandle(page, 24, 120); // far enough back that no window touches the live candle
    await expect.poll(async () => (await chartStoch(page))?.k).toBeCloseTo(50, 6);
    expect((await chartStoch(page))!.d).toBeCloseTo(50, 6);
  });

  test("unsmoothed %K follows the close inside its range; %D is its 3-candle average", async ({ page }) => {
    await setup(page, 14, 1, 3);
    for (const back of [24, 25, 26, 27]) {
      await hoverCandle(page, back, 120);
      await expect.poll(async () => (await chartStoch(page))?.k).toBeCloseTo(rawK(back), 6);
      expect((await chartStoch(page))!.d).toBeCloseTo(50, 6);
    }
  });

  test("the newest candle's range includes the live candle's high and low", async ({ page }) => {
    await setup(page, 14, 1, 1);
    // live candle: high base*1.0002, low base*0.9998, close base -> exactly the middle of the range
    await expect.poll(async () => (await chartStoch(page))?.k).toBeCloseTo(50, 6);
    expect((await chartStoch(page))!.d).toBeCloseTo(50, 6);
  });

  test("a two-candle lookback reacts to the last step", async ({ page }) => {
    await setup(page, 2, 1, 1);
    // window = this candle and the one before it; wicks are +-1 around each close
    // a -1 step (close 0, previous 1): high 2, low -1 -> (0+1)/3 = 33.3; a +2 step (close 2, previous 0): high 3, low -1 -> 3/4 = 75
    await hoverCandle(page, 30, 120); // close base, previous close base+1
    await expect.poll(async () => (await chartStoch(page))?.k).toBeCloseTo(100 / 3, 6);
    await hoverCandle(page, 29, 120); // close base+2, previous close base
    await expect.poll(async () => (await chartStoch(page))?.k).toBeCloseTo(75, 6);
  });

  test("invalid inputs are ignored and snap back", async ({ page }) => {
    await stochButton(page).click();
    await show(page).check();
    const bad: [ReturnType<typeof kPeriod>, string[]][] = [
      [kPeriod(page), ["1", "0", "201", "x", "", "3.5"]],
      [kSmooth(page), ["0", "51", "y", ""]],
      [dPeriod(page), ["0", "51", "z", "-2"]],
    ];
    for (const [input, values] of bad) {
      for (const v of values) {
        await input.fill(v);
        await expect(input).toHaveAttribute("aria-invalid", "true");
        expect((await chartStoch(page))?.label).toBe("Stoch 14,3,3");
      }
      await input.blur();
      await expect(input).toHaveAttribute("aria-invalid", "false");
    }
    await kPeriod(page).fill("200");
    await expect.poll(async () => (await chartStoch(page))?.label).toBe("Stoch 200,3,3");
    await kPeriod(page).fill("2");
    await expect.poll(async () => (await chartStoch(page))?.label).toBe("Stoch 2,3,3");
  });

  test("it stacks with RSI and volume: price | RSI | Stochastic | volume", async ({ page }) => {
    await stochButton(page).click();
    await show(page).check();
    await expect.poll(async () => (await paneHeights(page)).stochh).toBeGreaterThan(0);
    const only = await paneHeights(page);
    await page.getByRole("button", { name: "RSI", exact: true }).click();
    await page.getByRole("checkbox", { name: "Show RSI" }).check();
    await expect.poll(async () => (await paneHeights(page)).rsih).toBeGreaterThan(0);
    const both = await paneHeights(page);
    expect(both.stochh).toBeGreaterThan(0);
    expect(both.priceh).toBeLessThan(only.priceh);
    expect(both.priceh).toBeGreaterThanOrEqual(100); // the price chart stays usable
    expect(both.volh).toBe(only.volh);
    expect((await chartState(page)).vol).toBe("1");
    expect(await pixelsOfColor(page, CYAN)).toBeGreaterThan(60);
    expect(await pixelsOfColor(page, [0xf4, 0x72, 0xb6])).toBeGreaterThan(60);
  });

  test("turning it off gives the space back", async ({ page }) => {
    const before = await paneHeights(page);
    await stochButton(page).click();
    await show(page).check();
    await expect.poll(async () => (await paneHeights(page)).stochh).toBeGreaterThan(0);
    await show(page).uncheck();
    await expect.poll(async () => (await paneHeights(page)).stochh).toBe(0);
    expect((await paneHeights(page)).priceh).toBe(before.priceh);
    expect(await chartStoch(page)).toBeNull();
    expect(await pixelsOfColor(page, CYAN)).toBe(0);
  });

  test("the settings are remembered across a reload", async ({ page }) => {
    await setup(page, 9, 2, 4);
    await reloadTerminal(page);
    await expect.poll(async () => (await chartStoch(page))?.label).toBe("Stoch 9,2,4");
    await expect(stochButton(page)).toHaveAttribute("aria-pressed", "true");
  });

  test("the four indicator popovers are exclusive and close with Escape or an outside click", async ({ page }) => {
    const dialogs = ["Moving averages", "Bollinger Bands", "RSI", "Stochastic"];
    const buttons = ["Moving averages", "Bollinger Bands", "RSI", "Stochastic"];
    for (let i = 0; i < 4; i++) {
      await page.getByRole("button", { name: buttons[i], exact: true }).click();
      for (let j = 0; j < 4; j++) await expect(page.getByRole("dialog", { name: dialogs[j], exact: true })).toHaveCount(i === j ? 1 : 0);
    }
    await page.keyboard.press("Escape");
    await expect(popover(page)).toHaveCount(0);
    await stochButton(page).click();
    await page.mouse.click(40, 400);
    await expect(popover(page)).toHaveCount(0);
    await stochButton(page).click();
    await stochButton(page).click(); // the button toggles its own popover
    await expect(popover(page)).toHaveCount(0);
  });

  test("it follows the timeframe and stays within 0-100", async ({ page }) => {
    await stochButton(page).click();
    await show(page).check();
    await clickTimeframe(page, "1h");
    await expect.poll(async () => (await chartStoch(page))?.k).not.toBeNull();
    const r = (await chartStoch(page))!;
    for (const v of [r.k!, r.d!]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });
});

test("with fewer candles than the lookback the pane shows dashes", async ({ page, context }) => {
  await installMockBinance(context, { history: "zigzag", historyMinutes: 8 });
  await openTerminal(page);
  await stochButton(page).click();
  await show(page).check();
  await expect.poll(async () => (await chartStoch(page))?.label).toBe("Stoch 14,3,3");
  expect(await chartStoch(page)).toMatchObject({ k: null, d: null });
});

test("on a steady rise %K sits near the top of its range, matching the formula", async ({ page, context }) => {
  await installMockBinance(context, { history: "ramp" });
  await openTerminal(page);
  await stochButton(page).click();
  await show(page).check();
  await kSmooth(page).fill("1");
  await dPeriod(page).fill("1");
  await expect.poll(async () => (await chartStoch(page))?.label).toBe("Stoch 14,1,1");
  await page.keyboard.press("Escape");
  await hoverCandle(page, 40, 120);
  // ramp: candle j minutes back has high BASE-j+1, low BASE-j-1, close BASE-j+0.5; a 14-candle window ending 40 back
  // runs from the oldest low (BASE-53-1) to the newest high (BASE-40+1)
  const k = 40;
  const hh = BASE - k + 1;
  const ll = BASE - (k + 13) - 1;
  const c = BASE - k + 0.5;
  await expect.poll(async () => (await chartStoch(page))?.k).toBeCloseTo((100 * (c - ll)) / (hh - ll), 6);
});
