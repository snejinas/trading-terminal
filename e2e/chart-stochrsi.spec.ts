import type { Page } from "@playwright/test";
import { expect, test } from "./support/test";
import { installMockBinance } from "./support/mockBinance";
import { chartCanvas, chartState, chartStochRsi, clickTimeframe, hoverCandle, openTerminal, paneHeights, reloadTerminal } from "./support/terminal";

const button = (page: Page) => page.getByRole("button", { name: "Stochastic RSI", exact: true });
const popover = (page: Page) => page.getByRole("dialog", { name: "Stochastic RSI" });
const show = (page: Page) => page.getByRole("checkbox", { name: "Show Stochastic RSI" });
const field = (page: Page, name: "RSI period" | "lookback" | "K smoothing" | "D smoothing") =>
  page.getByLabel(name === "lookback" ? "StochRSI lookback" : `StochRSI ${name}`);
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
 * Independent reference: Wilder RSI, then the stochastic of it, then the two SMAs, over the zigzag closes the mock
 * serves (every three minutes the price steps +2, -1, -1; the newest candle closes at the base price = step 0).
 */
function expectedStochRsi(loaded: number, rp: number, sp: number, ks: number, ds: number, back: number): { k: number | null; d: number | null } {
  const z = [0, 2, 1];
  const closes = Array.from({ length: loaded }, (_, i) => z[(((i - (loaded - 1)) % 3) + 3) % 3]);
  const gains = closes.slice(1).map((c, i) => Math.max(c - closes[i], 0));
  const losses = closes.slice(1).map((c, i) => Math.max(closes[i] - c, 0));
  const rsi: (number | null)[] = closes.map(() => null);
  let ag = gains.slice(0, rp).reduce((a, b) => a + b, 0) / rp;
  let al = losses.slice(0, rp).reduce((a, b) => a + b, 0) / rp;
  const val = () => (al === 0 ? (ag === 0 ? 50 : 100) : 100 - 100 / (1 + ag / al));
  rsi[rp] = val();
  for (let j = rp; j < gains.length; j++) {
    ag = (ag * (rp - 1) + gains[j]) / rp;
    al = (al * (rp - 1) + losses[j]) / rp;
    rsi[j + 1] = val();
  }
  const raw = rsi.map((x, i) => {
    if (i + 1 < sp) return null;
    const w = rsi.slice(i + 1 - sp, i + 1);
    if (w.some((y) => y === null)) return null;
    const hh = Math.max(...(w as number[]));
    const ll = Math.min(...(w as number[]));
    return hh === ll ? 50 : (100 * ((x as number) - ll)) / (hh - ll);
  });
  const mean = (arr: (number | null)[], i: number, p: number) => {
    if (i + 1 < p) return null;
    const w = arr.slice(i + 1 - p, i + 1);
    return w.some((y) => y === null) ? null : (w as number[]).reduce((a, b) => a + b, 0) / p;
  };
  const k = raw.map((_, i) => mean(raw, i, ks));
  const at = loaded - 1 - back;
  return { k: k[at], d: mean(k, at, ds) };
}

async function configure(page: Page, rp: number, sp: number, ks: number, ds: number) {
  await button(page).click();
  await show(page).check();
  await field(page, "RSI period").fill(String(rp));
  await field(page, "lookback").fill(String(sp));
  await field(page, "K smoothing").fill(String(ks));
  await field(page, "D smoothing").fill(String(ds));
  await expect.poll(async () => (await chartStochRsi(page))?.label).toBe(`StochRSI ${rp},${sp},${ks},${ds}`);
  await page.keyboard.press("Escape"); // the popover would otherwise sit on top of the candles being hovered
  await expect(popover(page)).toHaveCount(0);
}

test.describe("Stochastic RSI on a repeating +2 / -1 / -1 price pattern", () => {
  test.beforeEach(async ({ page, context }) => {
    await installMockBinance(context, { history: "zigzag" });
    await openTerminal(page);
  });

  test("it is off by default: no pane, no pixels", async ({ page }) => {
    await expect(button(page)).toHaveAttribute("aria-pressed", "false");
    expect(await chartStochRsi(page)).toBeNull();
    expect((await paneHeights(page)).osch).toBe(0);
    expect(await pixelsOfColor(page, CYAN)).toBe(0);
    expect(await pixelsOfColor(page, FUCHSIA)).toBe(0);
  });

  test("the separate RSI and Stochastic buttons are gone", async ({ page }) => {
    await expect(page.getByRole("button", { name: "RSI", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Stochastic", exact: true })).toHaveCount(0);
    await expect(button(page)).toHaveCount(1);
  });

  test("turning it on opens one pane under the price chart and draws both lines", async ({ page }) => {
    const before = await paneHeights(page);
    await button(page).click();
    await show(page).check();
    await expect.poll(async () => (await paneHeights(page)).osch).toBeGreaterThanOrEqual(44);
    const after = await paneHeights(page);
    expect(after.priceh).toBeLessThan(before.priceh);
    expect(after.volh).toBe(before.volh);
    expect((await chartState(page)).vol).toBe("1");
    expect(await chartStochRsi(page)).toMatchObject({ label: "StochRSI 14,14,3,3" });
    expect(await pixelsOfColor(page, CYAN)).toBeGreaterThan(60);
    expect(await pixelsOfColor(page, FUCHSIA)).toBeGreaterThan(60);
  });

  test("the newest %K and %D are exactly what an independent calculation gives", async ({ page }) => {
    await button(page).click();
    await show(page).check();
    await page.keyboard.press("Escape");
    const loaded = (await chartState(page)).loaded;
    const want = expectedStochRsi(loaded, 14, 14, 3, 3, 0);
    expect(want.k).not.toBeNull();
    await expect.poll(async () => (await chartStochRsi(page))?.k).toBeCloseTo(want.k!, 6);
    expect((await chartStochRsi(page))!.d).toBeCloseTo(want.d!, 6);
  });

  test("hovering a candle shows the values as of that candle", async ({ page }) => {
    await configure(page, 14, 14, 3, 3);
    const loaded = (await chartState(page)).loaded;
    const seen = new Set<number>();
    for (const back of [20, 21, 22, 30]) {
      const want = expectedStochRsi(loaded, 14, 14, 3, 3, back);
      await hoverCandle(page, back, 120);
      await expect.poll(async () => (await chartStochRsi(page))?.k, { message: `back ${back}` }).toBeCloseTo(want.k!, 6);
      expect((await chartStochRsi(page))!.d).toBeCloseTo(want.d!, 6);
      seen.add(Math.round(want.k! * 1e4));
    }
    expect(seen.size).toBeGreaterThan(1); // the values really differ from candle to candle
  });

  test("all four settings change the result, and unsmoothed it reaches the extremes", async ({ page }) => {
    await configure(page, 5, 7, 1, 1);
    const loaded = (await chartState(page)).loaded;
    let lo = 100;
    let hi = 0;
    for (const back of [20, 21, 22, 23, 24, 25]) {
      const want = expectedStochRsi(loaded, 5, 7, 1, 1, back);
      await hoverCandle(page, back, 120);
      await expect.poll(async () => (await chartStochRsi(page))?.k, { message: `back ${back}` }).toBeCloseTo(want.k!, 6);
      lo = Math.min(lo, want.k!);
      hi = Math.max(hi, want.k!);
    }
    expect(hi - lo).toBeGreaterThan(50); // a short lookback swings it widely
  });

  test("invalid inputs are ignored and snap back", async ({ page }) => {
    await button(page).click();
    await show(page).check();
    const cases: ["RSI period" | "lookback" | "K smoothing" | "D smoothing", string[]][] = [
      ["RSI period", ["1", "0", "201", "x", "", "3.5"]],
      ["lookback", ["1", "201", "y", ""]],
      ["K smoothing", ["0", "51", "z", ""]],
      ["D smoothing", ["0", "51", "w", "-2"]],
    ];
    for (const [name, values] of cases) {
      for (const v of values) {
        await field(page, name).fill(v);
        await expect(field(page, name)).toHaveAttribute("aria-invalid", "true");
        expect((await chartStochRsi(page))?.label).toBe("StochRSI 14,14,3,3");
      }
      await field(page, name).blur();
      await expect(field(page, name)).toHaveAttribute("aria-invalid", "false");
    }
    await field(page, "RSI period").fill("200");
    await expect.poll(async () => (await chartStochRsi(page))?.label).toBe("StochRSI 200,14,3,3");
  });

  test("a steadily rising price has a constant RSI, so it reads exactly 50", async ({ page, context }) => {
    // (this test re-installs the mock with the ramp history before loading)
    await context.unrouteAll();
    await installMockBinance(context, { history: "ramp" });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);
    await button(page).click();
    await show(page).check();
    await expect.poll(async () => (await chartStochRsi(page))?.k).toBeCloseTo(50, 9);
    expect((await chartStochRsi(page))!.d).toBeCloseTo(50, 9);
  });

  test("turning it off gives the space back; the setting is remembered", async ({ page }) => {
    const before = await paneHeights(page);
    await configure(page, 9, 8, 2, 4);
    await reloadTerminal(page);
    await expect.poll(async () => (await chartStochRsi(page))?.label).toBe("StochRSI 9,8,2,4");
    await expect(button(page)).toHaveAttribute("aria-pressed", "true");
    await button(page).click();
    await show(page).uncheck();
    await expect.poll(async () => (await paneHeights(page)).osch).toBe(0);
    expect((await paneHeights(page)).priceh).toBe(before.priceh);
    expect(await chartStochRsi(page)).toBeNull();
    expect(await pixelsOfColor(page, CYAN)).toBe(0);
  });

  test("it works with the volume pane and its button", async ({ page }) => {
    await button(page).click();
    await show(page).check();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Volume" }).click();
    await expect.poll(async () => (await chartState(page)).vol).toBe("0");
    const noVol = await paneHeights(page);
    expect(noVol.osch).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Volume" }).click();
    await expect.poll(async () => (await paneHeights(page)).volh).toBeGreaterThan(0);
    expect((await paneHeights(page)).priceh).toBeLessThan(noVol.priceh);
  });

  test("the indicator popovers are exclusive and close with Escape or an outside click", async ({ page }) => {
    const names = ["Moving averages", "Bollinger Bands", "Stochastic RSI", "Fibonacci retracement"];
    for (let i = 0; i < names.length; i++) {
      await page.getByRole("button", { name: names[i], exact: true }).click();
      for (let j = 0; j < names.length; j++) await expect(page.getByRole("dialog", { name: names[j], exact: true })).toHaveCount(i === j ? 1 : 0);
    }
    await page.keyboard.press("Escape");
    await expect(popover(page)).toHaveCount(0);
    await button(page).click();
    await page.mouse.click(40, 400);
    await expect(popover(page)).toHaveCount(0);
    await button(page).click();
    await button(page).click();
    await expect(popover(page)).toHaveCount(0);
  });

  test("it follows the timeframe and stays within 0-100", async ({ page }) => {
    await button(page).click();
    await show(page).check();
    await clickTimeframe(page, "1h");
    await expect.poll(async () => (await chartStochRsi(page))?.k).not.toBeNull();
    const r = (await chartStochRsi(page))!;
    for (const v of [r.k!, r.d!]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });
});

test("with too little history it shows dashes instead of values", async ({ page, context }) => {
  await installMockBinance(context, { history: "zigzag", historyMinutes: 20 }); // 21 candles: RSI 14 needs 15, the lookback 14 more
  await openTerminal(page);
  await button(page).click();
  await show(page).check();
  await expect.poll(async () => (await chartStochRsi(page))?.label).toBe("StochRSI 14,14,3,3");
  expect(await chartStochRsi(page)).toMatchObject({ k: null, d: null });
});

test("settings saved by the removed RSI and Stochastic panes are ignored", async ({ page, context }) => {
  await installMockBinance(context, { history: "zigzag" });
  await page.addInitScript(() => {
    localStorage.setItem("lifeinception.terminal.chart.rsi.v1", JSON.stringify({ enabled: true, period: 14 }));
    localStorage.setItem("lifeinception.terminal.chart.stoch.v1", JSON.stringify({ enabled: true, k: 14, smooth: 3, d: 3 }));
  });
  await openTerminal(page);
  expect(await chartStochRsi(page)).toBeNull();
  expect((await paneHeights(page)).osch).toBe(0);
});
