import type { Page } from "@playwright/test";
import { expect, test } from "./support/test";
import { BASE_PRICES, installMockBinance, blockBinance } from "./support/mockBinance";
import { chartLiq, chartState, clickTimeframe, heatPixels, openTerminal, pixelAt, pointAt, priceScale, reloadTerminal } from "./support/terminal";

const BASE = BASE_PRICES.BTCUSDT;
const MIN = 60_000;
const liqButton = (page: Page) => page.getByRole("button", { name: "Liquidation heatmap" });
const TIERS = [
  { lev: 5, share: 0.1 },
  { lev: 10, share: 0.3 },
  { lev: 25, share: 0.3 },
  { lev: 50, share: 0.2 },
  { lev: 100, share: 0.1 },
];
const liqPrice = (entry: number, lev: number, side: "long" | "short") => (side === "long" ? entry * (1 - 1 / lev + 0.005) : entry * (1 + 1 / lev - 0.005));
/** The mock's 1-minute candle k minutes from the current minute (see MockOptions.history = "swing"). */
const swing = (k: number) => {
  if (k === 0) return { h: BASE * 1.0002, l: BASE * 0.9998, c: BASE }; // the live candle comes from the stream
  const c = BASE * (1 + 0.03 * Math.sin((2 * Math.PI * k) / 48));
  return { h: c * 1.001, l: c * 0.999, c };
};
const turnOn = async (page: Page) => {
  await liqButton(page).click();
  await expect.poll(() => chartLiq(page)).not.toBeNull();
};

test.describe("heatmap from volume (the futures host is unreachable)", () => {
  let spikeT: number;
  test.beforeEach(async ({ page, context }) => {
    const mock = await installMockBinance(context, { history: "swing", spikeMinutesAgo: 60 });
    spikeT = mock.spikeT!;
    await openTerminal(page);
  });

  test("it is off by default", async ({ page }) => {
    await expect(liqButton(page)).toHaveAttribute("aria-pressed", "false");
    expect(await chartLiq(page)).toBeNull();
  });

  test("turning it on shades the price pane and falls back to volume", async ({ page }) => {
    const off = await heatPixels(page);
    await turnOn(page);
    const s = (await chartLiq(page))!;
    expect(s.mode).toBe("volume");
    expect(s.max).toBeGreaterThan(0);
    expect(s.rows).toBeGreaterThan(20);
    const loaded = (await chartState(page)).loaded;
    expect(s.segments).toBe(loaded * 10); // every candle has volume: 5 leverage tiers x 2 sides
    expect(await heatPixels(page)).toBeGreaterThan(off + 1500);
    await expect(liqButton(page)).toHaveAttribute("aria-pressed", "true");
  });

  test("the largest levels are the spike candle's: right prices, sizes and consumption times", async ({ page }) => {
    await turnOn(page);
    const top = (await chartLiq(page))!.top.slice(0, 10);
    const { c: entry } = swing(-60); // the spike candle sits at the bottom of a swing; typical price = close
    expect(top.map((t) => `${t.side}${t.lev}`).sort()).toEqual(TIERS.flatMap((t) => [`long${t.lev}`, `short${t.lev}`]).sort());
    let alive = 0;
    let consumed = 0;
    for (const t of top) {
      expect(t.fromT).toBe(spikeT);
      expect(t.price).toBeCloseTo(liqPrice(entry, t.lev, t.side), 4);
      const share = TIERS.find((x) => x.lev === t.lev)!.share;
      expect(t.amount).toBeCloseTo(100 * entry * share * 0.5, 2); // volume 100 x price, split over tiers and sides
      // first later candle whose range reaches the level
      let expected: number | null = null;
      for (let k = -59; k <= 0 && expected === null; k++) {
        const x = swing(k);
        if (t.side === "long" ? x.l <= t.price : x.h >= t.price) expected = spikeT + (k + 60) * MIN;
      }
      expect(t.toT, `${t.side} ${t.lev}x`).toBe(expected);
      if (expected === null) alive++;
      else consumed++;
    }
    expect(alive).toBeGreaterThan(0); // some levels survive ...
    expect(consumed).toBeGreaterThan(0); // ... and some were traded through
  });

  test("a surviving level is drawn as heat at its price, a clear row is not", async ({ page }) => {
    await turnOn(page);
    const sc = await priceScale(page);
    const alive = (await chartLiq(page))!.top.slice(0, 10).find((t) => t.toT === null && t.price > sc.lo && t.price < sc.hi);
    expect(alive, "an alive level inside the visible range").toBeTruthy();
    const p = await pointAt(page, 3, alive!.price);
    const box = (await page.locator("canvas[role=application]").boundingBox())!;
    const step = (box.width - 84) / (await chartState(page)).count;
    const px = await pixelAt(page, p.x - box.x - step / 2, p.y - box.y); // between two candles
    const bg = [11, 14, 20];
    expect(Math.abs(px[0] - bg[0]) + Math.abs(px[1] - bg[1]) + Math.abs(px[2] - bg[2])).toBeGreaterThan(60);
  });

  test("hovering reports how hot the spot under the cursor is", async ({ page }) => {
    await turnOn(page);
    const box = (await page.locator("canvas[role=application]").boundingBox())!;
    await page.mouse.move(box.x + 400, box.y + 160);
    await expect.poll(async () => (await chartLiq(page))?.hover).not.toBeNull();
    const h = (await chartLiq(page))!.hover!;
    expect(h.pct).toBeGreaterThanOrEqual(0);
    expect(h.pct).toBeLessThanOrEqual(100);
    expect(h.price).toBeGreaterThan(BASE * 0.9);
  });

  test("the choice is remembered across a reload", async ({ page }) => {
    await turnOn(page);
    await reloadTerminal(page);
    await expect.poll(async () => (await chartLiq(page))?.mode).toBe("volume");
    await expect(liqButton(page)).toHaveAttribute("aria-pressed", "true");
    await liqButton(page).click();
    await expect.poll(() => chartLiq(page)).toBeNull();
    await reloadTerminal(page);
    expect(await chartLiq(page)).toBeNull();
  });

  test("it follows zoom, scroll and the timeframe", async ({ page }) => {
    await turnOn(page);
    await page.locator("canvas[role=application]").focus();
    for (let i = 0; i < 3; i++) await page.keyboard.press("+");
    await expect.poll(async () => (await chartState(page)).count).toBeLessThan(90);
    expect((await chartLiq(page))!.cols).toBeLessThanOrEqual((await chartState(page)).count + 2);
    await page.keyboard.press("Shift+ArrowLeft");
    await expect.poll(async () => (await chartLiq(page))?.max).toBeGreaterThan(0);

    await clickTimeframe(page, "1h");
    await expect.poll(async () => (await chartState(page)).loaded).toBeGreaterThan(0);
    await expect.poll(async () => (await chartLiq(page))?.segments).toBeGreaterThan(0);
    expect((await chartLiq(page))!.mode).toBe("volume");
  });

  test("it coexists with the oscillator panes (the heat stays in the price pane)", async ({ page }) => {
    await turnOn(page);
    await page.getByRole("button", { name: "RSI", exact: true }).click();
    await page.getByRole("checkbox", { name: "Show RSI" }).check();
    await page.keyboard.press("Escape");
    const s = (await chartLiq(page))!;
    expect(s.max).toBeGreaterThan(0);
    const priceh = await page.locator("canvas[role=application]").evaluate((c) => Number((c as HTMLCanvasElement).dataset.priceh));
    expect(s.rows).toBeLessThanOrEqual(Math.floor((priceh - 12) / 3));
  });
});

test.describe("heatmap from open interest", () => {
  test("open-interest growth drives it: five candles share the jump", async ({ page, context }) => {
    const mock = await installMockBinance(context, { history: "swing", oi: { spikeMinutesAgo: 70 } });
    await openTerminal(page);
    await turnOn(page);
    await expect.poll(async () => (await chartLiq(page))?.mode).toBe("oi");
    const s = (await chartLiq(page))!;
    expect(mock.futures).toContain("BTCUSDT/5m");
    // +100M USD of growth between two 5-minute snapshots lands on the five 1-minute candles in between: 2e7 each
    expect(s.segments).toBe(5 * 10);
    const first = mock.oiSpikeT! - 5 * MIN;
    for (const t of s.top) {
      expect(t.fromT).toBeGreaterThanOrEqual(first);
      expect(t.fromT).toBeLessThan(mock.oiSpikeT!);
      expect(t.amount).toBeCloseTo(2e7 * TIERS.find((x) => x.lev === t.lev)!.share * 0.5, 0);
    }
    expect(s.top.slice(0, 10).every((t) => Math.abs(t.amount - 3e6) < 1)).toBe(true); // the 10x and 25x tiers: 0.3 x 0.5 x 2e7
  });

  test("flat open interest means no new positions, so an empty map (not a fallback)", async ({ page, context }) => {
    await installMockBinance(context, { history: "swing", oi: {} });
    await openTerminal(page);
    const off = await heatPixels(page);
    await turnOn(page);
    await expect.poll(async () => (await chartLiq(page))?.mode).toBe("oi");
    const s = (await chartLiq(page))!;
    expect(s.segments).toBe(0);
    expect(s.max).toBe(0);
    expect(Math.abs((await heatPixels(page)) - off)).toBeLessThan(100); // nothing was shaded
  });

  test("a higher timeframe asks for the matching open-interest period", async ({ page, context }) => {
    const mock = await installMockBinance(context, { history: "swing", oi: { spikeMinutesAgo: 70 } });
    await openTerminal(page);
    await turnOn(page);
    await clickTimeframe(page, "1h");
    await expect.poll(() => mock.futures.some((f) => f.endsWith("/1h"))).toBe(true);
    await expect.poll(async () => (await chartLiq(page))?.mode).toBe("oi");
  });

  test("open interest is fetched once, not on every frame", async ({ page, context }) => {
    const mock = await installMockBinance(context, { history: "swing", oi: { spikeMinutesAgo: 70 } });
    await openTerminal(page);
    await turnOn(page);
    await page.waitForTimeout(2500); // ~10 redraws
    expect(mock.futures.filter((f) => f === "BTCUSDT/5m").length).toBe(1);
  });

  test("an unreachable futures host is retried at most once a minute", async ({ page, context }) => {
    const mock = await installMockBinance(context, { history: "swing" }); // no oi: the futures host aborts
    await openTerminal(page);
    await turnOn(page);
    await page.waitForTimeout(2500);
    expect(mock.futures.filter((f) => f === "BTCUSDT/5m").length).toBe(1);
    expect((await chartLiq(page))!.mode).toBe("volume");
  });
});

test("the simulated feed (Binance unreachable) has a volume-based heatmap", async ({ page, context }) => {
  await blockBinance(context);
  await openTerminal(page);
  await turnOn(page);
  const s = (await chartLiq(page))!;
  expect(s.mode).toBe("volume");
  expect(s.segments).toBeGreaterThan(0);
});
