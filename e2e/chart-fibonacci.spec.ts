import type { Page } from "@playwright/test";
import { expect, test } from "./support/test";
import { BASE_PRICES, installMockBinance } from "./support/mockBinance";
import { chartCanvas, chartFib, chartState, clickTimeframe, openTerminal, pixelAt, pointAt, priceScale, reloadTerminal, runCommand } from "./support/terminal";

const BASE = BASE_PRICES.BTCUSDT;
const MIN = 60_000;
const fibButton = (page: Page) => page.getByRole("button", { name: "Fibonacci retracement", exact: true });
const popover = (page: Page) => page.getByRole("dialog", { name: "Fibonacci retracement" });
const drawButton = (page: Page) => page.getByRole("button", { name: "Draw retracement" });
const hint = (page: Page) => page.getByRole("status");
const RATIOS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

/** Open the popover, press Draw, then click the start and end of the move. */
async function place(page: Page, a: [number, number], b: [number, number]) {
  await fibButton(page).click();
  await drawButton(page).click();
  await expect(hint(page)).toContainText("start of the move");
  const pa = await pointAt(page, a[0], a[1]);
  await page.mouse.click(pa.x, pa.y);
  await expect(hint(page)).toContainText("end of the move");
  const pb = await pointAt(page, b[0], b[1]);
  await page.mouse.click(pb.x, pb.y);
  await expect(hint(page)).toHaveCount(0);
}

test.describe("Fibonacci retracement on a rising ramp", () => {
  test.beforeEach(async ({ page, context }) => {
    await installMockBinance(context, { history: "ramp" });
    await openTerminal(page);
  });

  test("there are none by default", async ({ page }) => {
    await expect(fibButton(page)).toHaveAttribute("aria-pressed", "false");
    expect((await chartFib(page)).items).toHaveLength(0);
    await fibButton(page).click();
    await expect(popover(page)).toContainText("None on BTCUSDT");
  });

  test("two clicks place a retracement with exact levels", async ({ page }) => {
    await place(page, [60, BASE - 70], [10, BASE - 10]);
    const f = (await chartFib(page)).items;
    expect(f).toHaveLength(1);
    const sc = await priceScale(page);
    expect(f[0].a.p).toBeCloseTo(BASE - 70, -1); // within a couple of dollars: positions are whole pixels
    expect(Math.abs(f[0].a.p - (BASE - 70))).toBeLessThanOrEqual(sc.perPixel * 1.5);
    expect(Math.abs(f[0].b.p - (BASE - 10))).toBeLessThanOrEqual(sc.perPixel * 1.5);
    expect(f[0].b.t - f[0].a.t).toBe(50 * MIN); // snapped to candles 60 and 10 back
    expect(f[0].levels.map((l) => l.r)).toEqual(RATIOS);
    for (const l of f[0].levels) {
      expect(l.price).toBeCloseTo(f[0].b.p - (f[0].b.p - f[0].a.p) * l.r, 6);
      expect(l.y).toBeCloseTo(sc.yOf(l.price), 3);
    }
    expect(f[0].levels[0].price).toBeCloseTo(f[0].b.p, 6); // level 0 is the end of the move
    expect(f[0].levels[6].price).toBeCloseTo(f[0].a.p, 6); // level 1 is its start
    await expect(fibButton(page)).toHaveAttribute("aria-pressed", "true");
    await expect.poll(async () => (await chartState(page)).offset).toBe(0); // placing did not pan
  });

  test("level lines are drawn from the earlier anchor to the right edge", async ({ page }) => {
    await place(page, [60, BASE - 70], [10, BASE - 10]);
    const f = (await chartFib(page)).items[0];
    const l = f.levels.find((x) => x.r === 0.618)!;
    const box = (await chartCanvas(page).boundingBox())!;
    const plotW = box.width - 84;
    const cyan = await pixelAt(page, plotW - 30, Math.round(l.y));
    expect(Math.abs(cyan[0] - 0x22) + Math.abs(cyan[1] - 0xd3) + Math.abs(cyan[2] - 0xee)).toBeLessThan(25);
    const before = await pixelAt(page, Math.min(f.ax, f.bx) - 30, Math.round(l.y));
    expect(Math.abs(before[0] - 0x22) + Math.abs(before[1] - 0xd3) + Math.abs(before[2] - 0xee)).toBeGreaterThan(60);
  });

  test("Escape cancels at either step and nothing is created", async ({ page }) => {
    await fibButton(page).click();
    await drawButton(page).click();
    await page.keyboard.press("Escape");
    await expect(hint(page)).toHaveCount(0);
    await drawButton(page).count(); // popover closed by Draw
    await fibButton(page).click();
    await drawButton(page).click();
    const p = await pointAt(page, 40, BASE - 40);
    await page.mouse.click(p.x, p.y);
    await expect(hint(page)).toContainText("end of the move");
    await page.keyboard.press("Escape");
    await expect(hint(page)).toHaveCount(0);
    const q = await pointAt(page, 20, BASE - 20);
    await page.mouse.click(q.x, q.y);
    expect((await chartFib(page)).items).toHaveLength(0);
    expect((await chartFib(page)).step).toBe(0);
  });

  test("clicks outside the price pane are ignored while placing", async ({ page }) => {
    await fibButton(page).click();
    await drawButton(page).click();
    const box = (await chartCanvas(page).boundingBox())!;
    const sc = await priceScale(page);
    await page.mouse.click(box.x + 300, box.y + sc.priceh + 20); // the volume pane
    await page.mouse.click(box.x + box.width - 30, box.y + 200); // the price axis
    await expect(hint(page)).toContainText("start of the move");
    expect((await chartFib(page)).step).toBe(1);
  });

  test("they are remembered across a reload, per symbol", async ({ page }) => {
    await place(page, [60, BASE - 70], [10, BASE - 10]);
    const before = (await chartFib(page)).items[0];
    await reloadTerminal(page);
    const after = (await chartFib(page)).items;
    expect(after).toHaveLength(1);
    expect(after[0].a).toEqual(before.a);
    expect(after[0].b).toEqual(before.b);

    await runCommand(page, "chart ETHUSDT");
    await expect.poll(async () => (await chartFib(page)).items.length).toBe(0);
    await fibButton(page).click();
    await expect(popover(page)).toContainText("None on ETHUSDT");
    await runCommand(page, "chart BTCUSDT");
    await expect.poll(async () => (await chartFib(page)).items.length).toBe(1);
  });

  test("they stay anchored in time and price through zoom, scroll and a timeframe change", async ({ page }) => {
    await place(page, [60, BASE - 70], [10, BASE - 10]);
    const f0 = (await chartFib(page)).items[0];
    await chartCanvas(page).focus();
    for (let i = 0; i < 3; i++) await page.keyboard.press("+");
    await expect.poll(async () => (await chartState(page)).count).toBeLessThan(90);
    let f = (await chartFib(page)).items[0];
    expect(f.a).toEqual(f0.a);
    expect(f.b).toEqual(f0.b);
    let sc = await priceScale(page);
    for (const l of f.levels) expect(l.y).toBeCloseTo(sc.yOf(l.price), 3); // follows the rescaled price axis
    expect(f.bx - f.ax).toBeGreaterThan(0);

    await page.keyboard.press("Shift+ArrowLeft");
    f = (await chartFib(page)).items[0];
    expect(f.a).toEqual(f0.a);

    await clickTimeframe(page, "5m");
    await expect.poll(async () => (await chartState(page)).loaded).toBeGreaterThan(0);
    f = (await chartFib(page)).items[0];
    expect(f.a).toEqual(f0.a);
    expect(f.b).toEqual(f0.b);
    sc = await priceScale(page);
    for (const l of f.levels) expect(l.y).toBeCloseTo(sc.yOf(l.price), 3);
  });

  test("an anchor can be dragged without panning the chart", async ({ page }) => {
    await place(page, [60, BASE - 70], [10, BASE - 10]);
    const f0 = (await chartFib(page)).items[0];
    const box = (await chartCanvas(page).boundingBox())!;
    await page.mouse.move(box.x + f0.bx, box.y + f0.by);
    await page.mouse.down();
    const target = await pointAt(page, 25, BASE - 30);
    await page.mouse.move(target.x, target.y, { steps: 5 });
    await page.mouse.up();
    const f1 = (await chartFib(page)).items[0];
    const sc = await priceScale(page);
    expect(f1.a).toEqual(f0.a); // the other end did not move
    expect(f1.b.t - f0.a.t).toBe(35 * MIN); // snapped to the candle 25 back
    expect(Math.abs(f1.b.p - (BASE - 30))).toBeLessThanOrEqual(sc.perPixel * 1.5);
    expect((await chartState(page)).offset).toBe(0);
    await reloadTerminal(page);
    expect((await chartFib(page)).items[0].b).toEqual(f1.b); // saved on drop
  });

  test("dragging empty chart still pans", async ({ page }) => {
    await place(page, [60, BASE - 70], [10, BASE - 10]);
    const box = (await chartCanvas(page).boundingBox())!;
    await page.mouse.move(box.x + 500, box.y + 60); // drag right: back in time (left would run into the live edge)
    await page.mouse.down();
    await page.mouse.move(box.x + 700, box.y + 60, { steps: 5 });
    await page.mouse.up();
    expect((await chartState(page)).offset).toBeGreaterThan(5);
  });

  test("the extensions toggle adds three levels and is remembered", async ({ page }) => {
    await place(page, [60, BASE - 70], [10, BASE - 10]);
    await fibButton(page).click();
    await page.getByRole("checkbox", { name: "Show extensions" }).check();
    await expect.poll(async () => (await chartFib(page)).items[0].levels.map((l) => l.r)).toEqual([...RATIOS, 1.272, 1.618, 2.618]);
    const f = (await chartFib(page)).items[0];
    expect(f.levels[8].price).toBeCloseTo(f.b.p - (f.b.p - f.a.p) * 1.618, 6);
    await reloadTerminal(page);
    expect((await chartFib(page)).ext).toBe(true);
    expect((await chartFib(page)).items[0].levels).toHaveLength(10);
  });

  test("retracements can be deleted one at a time or all together", async ({ page }) => {
    await place(page, [60, BASE - 70], [10, BASE - 10]);
    await place(page, [80, BASE - 85], [40, BASE - 45]);
    expect((await chartFib(page)).items).toHaveLength(2);
    const second = (await chartFib(page)).items[1];
    await fibButton(page).click();
    await page.getByRole("button", { name: "Delete retracement 1" }).click();
    await expect.poll(async () => (await chartFib(page)).items.length).toBe(1);
    expect((await chartFib(page)).items[0].id).toBe(second.id);
    await page.getByRole("button", { name: "Clear all retracements" }).click();
    await expect.poll(async () => (await chartFib(page)).items.length).toBe(0);
    await expect(fibButton(page)).toHaveAttribute("aria-pressed", "false");
    await reloadTerminal(page);
    expect((await chartFib(page)).items).toHaveLength(0);
  });

  test("the clicks of a placement do not count as a double-click reset", async ({ page }) => {
    await chartCanvas(page).focus();
    for (let i = 0; i < 3; i++) await page.keyboard.press("+");
    await expect.poll(async () => (await chartState(page)).count).toBeLessThan(90);
    const zoomed = (await chartState(page)).count;
    await fibButton(page).click();
    await drawButton(page).click();
    const a = await pointAt(page, 15, BASE - 15);
    await page.mouse.click(a.x, a.y);
    const b = await pointAt(page, 5, BASE - 5);
    await page.mouse.dblclick(b.x, b.y);
    await expect.poll(async () => (await chartFib(page)).items.length).toBe(1);
    await page.waitForTimeout(300);
    expect((await chartState(page)).count).toBe(zoomed);
  });

  test("it works next to the other indicator panels, which are exclusive with it", async ({ page }) => {
    await page.getByRole("button", { name: "RSI", exact: true }).click();
    await page.getByRole("checkbox", { name: "Show RSI" }).check();
    await page.keyboard.press("Escape");
    await place(page, [60, BASE - 70], [10, BASE - 10]); // the price pane is smaller now
    expect((await chartFib(page)).items).toHaveLength(1);
    await fibButton(page).click();
    await expect(popover(page)).toBeVisible();
    await page.getByRole("button", { name: "Moving averages" }).click();
    await expect(popover(page)).toHaveCount(0);
    await fibButton(page).click();
    await expect(page.getByRole("dialog", { name: "Moving averages" })).toHaveCount(0);
  });
});

test("the limit per symbol disables drawing", async ({ page, context }) => {
  await installMockBinance(context, { history: "ramp" });
  await page.addInitScript(() => {
    const t0 = Date.now() - 3_600_000;
    const items = Array.from({ length: 20 }, (_, i) => ({ id: `s${i}`, a: { t: t0 + i * 60000, p: 67000 + i }, b: { t: t0 + 600000 + i * 60000, p: 67500 + i } }));
    localStorage.setItem("lifeinception.terminal.chart.fib.v1.BTCUSDT", JSON.stringify(items));
  });
  await openTerminal(page);
  expect((await chartFib(page)).items).toHaveLength(20);
  await fibButton(page).click();
  await expect(drawButton(page)).toBeDisabled();
  await expect(drawButton(page)).toContainText("Limit of 20");
});

test("corrupt stored drawings are ignored", async ({ page, context }) => {
  await installMockBinance(context, { history: "ramp" });
  await page.addInitScript(() => {
    localStorage.setItem("lifeinception.terminal.chart.fib.v1.BTCUSDT", '[{"id":"x","a":{"t":"no","p":1},"b":null},{"junk":true}');
  });
  await openTerminal(page);
  expect((await chartFib(page)).items).toHaveLength(0);
  await place(page, [60, BASE - 70], [10, BASE - 10]);
  expect((await chartFib(page)).items).toHaveLength(1);
});

test("a retracement can be drawn on a higher timeframe and shows on 1m", async ({ page, context }) => {
  await installMockBinance(context, { history: "ramp" });
  await openTerminal(page);
  await clickTimeframe(page, "1h");
  await expect.poll(async () => (await chartState(page)).loaded).toBeGreaterThan(0);
  const s = await chartState(page);
  expect(s.count).toBeGreaterThan(0);
  await fibButton(page).click();
  await drawButton(page).click();
  const sc = await priceScale(page);
  const a = await pointAt(page, 10, sc.priceOf(sc.yOf(BASE) + 120));
  await page.mouse.click(a.x, a.y);
  const b = await pointAt(page, 2, sc.priceOf(sc.yOf(BASE) + 20));
  await page.mouse.click(b.x, b.y);
  await expect.poll(async () => (await chartFib(page)).items.length).toBe(1);
  const f = (await chartFib(page)).items[0];
  expect(f.b.t - f.a.t).toBe(8 * 60 * MIN); // whole hours
  await clickTimeframe(page, "1m");
  await expect.poll(async () => (await chartFib(page)).items.length).toBe(1);
  expect((await chartFib(page)).items[0].a).toEqual(f.a);
});
