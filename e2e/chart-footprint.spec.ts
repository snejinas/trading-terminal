import type { Page } from "@playwright/test";
import { expect, test } from "./support/test";
import { BASE_PRICES, blockBinance, installMockBinance, type Mock } from "./support/mockBinance";
import { LIVE_TRADES, REST_OVERLAP, TRADE_HISTORY, TRADE_SPACING_MS, allTrades } from "./support/mockTrades";
import { chartCanvas, chartFp, chartState, clickTimeframe, hoverCandle, openTerminal, pixelAt, pointAt, reloadTerminal, type FpCandle } from "./support/terminal";

const BASE = BASE_PRICES.BTCUSDT;
const MIN = 60_000;
// the newest REST page is ids 5..3004 (1000 trades), then 1005..2004... pages walk back from there: ids 5..3004 are fetched, 1..4 are not
const FIRST_ID = TRADE_HISTORY + REST_OVERLAP - 3000 + 1;
const TOTAL = TRADE_HISTORY + LIVE_TRADES - (FIRST_ID - 1); // ids FIRST_ID..3012, each counted once
const button = (page: Page) => page.getByRole("button", { name: "Order flow footprint", exact: true });

/** Independent reference: the candle [t, t + tfMs) regrouped into rows of `step`, from the mock's closed-form trades. */
function expectedCandle(mock: Mock, t: number, tfMs: number, step: number) {
  const rows = new Map<number, { b: number; s: number }>();
  for (const tr of allTrades(mock.curMinute, mock.startedAt, BASE)) {
    if (tr.t < t || tr.t >= t + tfMs) continue;
    const k = Math.floor(tr.p / step + 1e-9);
    const r = rows.get(k) ?? { b: 0, s: 0 };
    if (tr.m) r.s += tr.q;
    else r.b += tr.q;
    rows.set(k, r);
  }
  const levels = [...rows.entries()].sort((a, b) => b[0] - a[0]).map(([k, v]) => ({ k, ...v }));
  const buy = levels.reduce((a, l) => a + l.b, 0);
  const sell = levels.reduce((a, l) => a + l.s, 0);
  let poc = levels[0];
  for (const l of levels) if (l.b + l.s > poc.b + poc.s + 1e-12) poc = l;
  // diagonal imbalances at a ratio of 3, rows listed highest first
  const imb = levels.map((l, i) => {
    const lower = levels[i + 1];
    const higher = levels[i - 1];
    const lowerSold = lower && lower.k === l.k - 1 ? lower.s : 0;
    const higherBought = higher && higher.k === l.k + 1 ? higher.b : 0;
    return { bi: l.b > 0 && l.b >= 3 * lowerSold - 1e-12, si: l.s > 0 && l.s >= 3 * higherBought - 1e-12 };
  });
  return { levels, buy, sell, delta: buy - sell, pocK: poc?.k, imb };
}

async function zoomIn(page: Page, presses = 5) {
  await chartCanvas(page).focus();
  for (let i = 0; i < presses; i++) await page.keyboard.press("+");
  await expect.poll(async () => (await chartState(page)).count).toBeLessThanOrEqual(40);
}
async function turnOn(page: Page) {
  await button(page).click();
  await expect.poll(async () => (await chartFp(page))?.coverage?.trades).toBe(TOTAL);
}

test.describe("footprint from the mock exchange's trades", () => {
  let mock: Mock;
  test.beforeEach(async ({ page, context }) => {
    mock = await installMockBinance(context, { trades: { enabled: true } });
    await openTerminal(page);
  });

  test("it is off by default and asks for no trades", async ({ page }) => {
    await expect(button(page)).toHaveAttribute("aria-pressed", "false");
    expect(await chartFp(page)).toBeNull();
    expect(mock.tradeRequests).toHaveLength(0);
  });

  test("turning it on backfills the latest 3000 trades in three pages, once, without double counting the live ones", async ({ page }) => {
    await turnOn(page);
    expect(mock.tradeRequests).toEqual(["BTCUSDT/latest", `BTCUSDT/from${FIRST_ID + 1000}`, `BTCUSDT/from${FIRST_ID}`]);
    const cov = (await chartFp(page))!.coverage!;
    // ids 5..3004 over REST and 3001..3012 live: the four in both lists (3001..3004) count once
    expect(cov.trades).toBe(TOTAL);
    expect(TOTAL).toBe(TRADE_HISTORY + LIVE_TRADES - 4);
    expect(cov.firstT).toBe(mock.curMinute - (TRADE_HISTORY - FIRST_ID + 1) * TRADE_SPACING_MS); // the oldest trade fetched
    expect(cov.lastT).toBe(mock.startedAt);
    await page.waitForTimeout(2200);
    expect(mock.tradeRequests).toHaveLength(3); // no refetching while it stays on
  });

  test("each candle's rows hold exactly the buy and sell volume of its trades", async ({ page }) => {
    await turnOn(page);
    await zoomIn(page);
    const fp = (await chartFp(page))!;
    expect(fp.zoomedOut).toBe(false);
    const step = fp.step!;
    for (const j of [1, 5, 12, 20]) {
      const t = mock.curMinute - j * MIN;
      const got = fp.candles!.find((c) => c.t === t) as FpCandle;
      expect(got, `candle ${j} back`).toBeTruthy();
      const want = expectedCandle(mock, t, MIN, step);
      expect(got.levels.map((l) => l.k)).toEqual(want.levels.map((l) => l.k));
      got.levels.forEach((l, i) => {
        expect(l.b, `${j} back, row ${l.k} bought`).toBeCloseTo(want.levels[i].b, 9);
        expect(l.s, `${j} back, row ${l.k} sold`).toBeCloseTo(want.levels[i].s, 9);
        expect(l.price).toBeCloseTo(l.k * step, 6);
        expect(l.bi).toBe(want.imb[i].bi);
        expect(l.si).toBe(want.imb[i].si);
      });
      expect(got.buy).toBeCloseTo(want.buy, 9);
      expect(got.sell).toBeCloseTo(want.sell, 9);
      expect(got.delta).toBeCloseTo(want.delta, 9);
      expect(got.pocK).toBe(want.pocK);
    }
    // 20 trades a minute in total: nothing lost, nothing invented
    const c5 = fp.candles!.find((c) => c.t === mock.curMinute - 5 * MIN)!;
    const totalQty = allTrades(mock.curMinute, mock.startedAt, BASE).filter((x) => x.t >= c5.t && x.t < c5.t + MIN).reduce((a, x) => a + x.q, 0);
    expect(c5.buy + c5.sell).toBeCloseTo(totalQty, 9);
  });

  test("the current candle includes the live trades", async ({ page }) => {
    await turnOn(page);
    await zoomIn(page);
    const fp = (await chartFp(page))!;
    const got = fp.candles!.find((c) => c.t === mock.curMinute)!;
    expect(got).toBeTruthy();
    const want = expectedCandle(mock, mock.curMinute, MIN, fp.step!);
    expect(got.buy + got.sell).toBeCloseTo(want.buy + want.sell, 9);
    expect(got.buy + got.sell).toBeGreaterThan(0); // only the 12 live trades fall in this minute
    expect(got.delta).toBeCloseTo(want.delta, 9);
  });

  test("a candle's rows are tall enough to read, on a round price step", async ({ page }) => {
    await turnOn(page);
    const fp = (await chartFp(page))!;
    expect(fp.rowPx!).toBeGreaterThanOrEqual(10.99);
    const m = fp.step! / Math.pow(10, Math.floor(Math.log10(fp.step!)));
    expect([1, 2, 2.5, 5]).toContain(Math.round(m * 1000) / 1000);
  });

  test("cells are coloured by who was more aggressive", async ({ page }) => {
    await turnOn(page);
    await zoomIn(page);
    const fp = (await chartFp(page))!;
    let checked = 0;
    for (const j of [2, 6, 9, 14]) {
      const c = fp.candles!.find((x) => x.t === mock.curMinute - j * MIN)!;
      const l = c.levels.find((x) => x.k === c.pocK)!;
      const p = await pointAt(page, j, (l.k + 0.5) * fp.step!);
      const box = (await chartCanvas(page).boundingBox())!;
      const [r, g] = await pixelAt(page, p.x - box.x, p.y - box.y);
      if (l.b > l.s) expect(g, `candle ${j} back should read green`).toBeGreaterThan(r + 15);
      else if (l.s > l.b) expect(r, `candle ${j} back should read red`).toBeGreaterThan(g + 15);
      checked++;
    }
    expect(checked).toBe(4);
  });

  test("hovering a candle reads its summary", async ({ page }) => {
    await turnOn(page);
    await zoomIn(page);
    await hoverCandle(page, 7, 140);
    await expect.poll(async () => (await chartFp(page))?.hover?.t).toBe(mock.curMinute - 7 * MIN);
    const fp = (await chartFp(page))!;
    const want = expectedCandle(mock, mock.curMinute - 7 * MIN, MIN, fp.step!);
    expect(fp.hover!.delta).toBeCloseTo(want.delta, 9);
    expect(fp.hover!.buy).toBeCloseTo(want.buy, 9);
    expect(fp.hover!.sell).toBeCloseTo(want.sell, 9);
  });

  test("zoomed far out it stops drawing and says why; older candles than the trades have no footprint", async ({ page }) => {
    await turnOn(page);
    await chartCanvas(page).focus();
    for (let i = 0; i < 3; i++) await page.keyboard.press("-");
    await expect.poll(async () => (await chartState(page)).count).toBeGreaterThan(120);
    const out = (await chartFp(page))!;
    expect(out.zoomedOut).toBe(true);
    expect(out.withData).toBe(0);
    expect(out.candles).toEqual([]);

    await page.keyboard.press("0"); // back to the live edge, then in
    for (let i = 0; i < 8; i++) await page.keyboard.press("+");
    await expect.poll(async () => (await chartState(page)).count).toBeLessThanOrEqual(40);
    await page.keyboard.press("Home"); // the oldest loaded candles are far beyond the 150 minutes of trades
    await expect.poll(async () => (await chartState(page)).offset).toBeGreaterThan(150);
    const old = (await chartFp(page))!;
    expect(old.zoomedOut).toBe(false);
    expect(old.withData).toBe(0);
    expect(old.candles).toEqual([]);
  });

  test("a five-minute candle merges its five minutes", async ({ page }) => {
    await turnOn(page);
    await clickTimeframe(page, "5m");
    await expect.poll(async () => (await chartState(page)).loaded).toBeGreaterThan(0);
    await zoomIn(page);
    const fp = (await chartFp(page))!;
    const t = Math.floor((mock.curMinute - 10 * MIN) / (5 * MIN)) * 5 * MIN;
    const got = fp.candles!.find((c) => c.t === t)!;
    expect(got, "a 5m candle a few candles back").toBeTruthy();
    const want = expectedCandle(mock, t, 5 * MIN, fp.step!);
    expect(got.buy).toBeCloseTo(want.buy, 9);
    expect(got.sell).toBeCloseTo(want.sell, 9);
    expect(got.levels).toHaveLength(want.levels.length);
    expect(got.buy + got.sell).toBeCloseTo(100 * 0.03, 6); // 100 trades whose sizes average 0.03
  });

  test("the choice is remembered; a reload backfills again", async ({ page }) => {
    await turnOn(page);
    await reloadTerminal(page);
    await expect.poll(async () => (await chartFp(page))?.coverage?.trades).toBe(TOTAL);
    await expect(button(page)).toHaveAttribute("aria-pressed", "true");
    await button(page).click();
    await expect.poll(() => chartFp(page)).toBeNull();
    await reloadTerminal(page);
    expect(await chartFp(page)).toBeNull();
  });

  test("it sits next to the volume profile and the liquidation heatmap", async ({ page }) => {
    await turnOn(page);
    await page.getByRole("button", { name: "Volume profile", exact: true }).click();
    await page.getByRole("checkbox", { name: "Show volume profile" }).check();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Liquidation heatmap" }).click();
    await zoomIn(page);
    await expect.poll(async () => (await chartFp(page))?.withData).toBeGreaterThan(10);
  });
});

test("without trade data it waits quietly and asks at most once a minute", async ({ page, context }) => {
  const mock = await installMockBinance(context, {}); // aggTrades is unreachable
  await openTerminal(page);
  await button(page).click();
  await page.waitForTimeout(2500);
  const fp = (await chartFp(page))!;
  expect(fp.available).toBe(true);
  expect(fp.coverage!.trades).toBe(0);
  expect(fp.withData).toBe(0);
  expect(mock.tradeRequests).toHaveLength(1);
});

test("the simulated feed has no trades, and says so", async ({ page, context }) => {
  await blockBinance(context);
  await openTerminal(page);
  await button(page).click();
  await expect.poll(async () => (await chartFp(page))?.available).toBe(false);
});
