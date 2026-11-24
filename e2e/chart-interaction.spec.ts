import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "./support/test";
import { installMockBinance, type MockOptions } from "./support/mockBinance";
import { chartCanvas, chartState, clickTimeframe, defaultCandleCount, openTerminal } from "./support/terminal";

/** The mock exchange has 1801 minutes of history, so scrolling back reaches a real "start of market". */
const HISTORY_MINUTES = 1800;

async function open(page: Page, context: BrowserContext, extra: MockOptions = {}) {
  const mock = await installMockBinance(context, { historyMinutes: HISTORY_MINUTES, ...extra });
  await openTerminal(page);
  return mock;
}

async function geometry(page: Page) {
  const box = (await chartCanvas(page).boundingBox())!;
  const plotW = box.width - 84; // 72px price axis + 12px padding
  return { box, plotW, cx: box.x + plotW / 2, cy: box.y + box.height / 2 };
}

const field = (page: Page, key: "count" | "offset" | "loaded" | "start") => expect.poll(async () => (await chartState(page))[key]);
const liveButton = (page: Page) => page.getByRole("button", { name: /Live/ });
const resetButton = (page: Page) => page.getByRole("button", { name: "Reset view" });

test("starts at the live edge with the automatic zoom", async ({ page, context }) => {
  await open(page, context);
  expect(await chartState(page)).toMatchObject({ offset: 0, count: await defaultCandleCount(page), loaded: 200 });
});

test.describe("zoom", () => {
  test("the wheel zooms in and out, within limits, without scrolling the page", async ({ page, context }) => {
    await open(page, context);
    const { cx, cy } = await geometry(page);
    await page.mouse.move(cx, cy);
    const initial = (await chartState(page)).count;

    await page.mouse.wheel(0, -300);
    await field(page, "count").toBeLessThan(initial);
    const zoomedIn = (await chartState(page)).count;
    await page.mouse.wheel(0, 300);
    await page.mouse.wheel(0, 300);
    await field(page, "count").toBeGreaterThan(zoomedIn);

    for (let i = 0; i < 25; i++) await page.mouse.wheel(0, -400);
    await field(page, "count").toBe(8); // most zoomed in
    for (let i = 0; i < 40; i++) await page.mouse.wheel(0, 400);
    await field(page, "count").toBe(600); // most zoomed out

    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  });

  test("the wheel event's default action is prevented", async ({ page, context }) => {
    await open(page, context);
    const prevented = await chartCanvas(page).evaluate((canvas) => {
      const event = new WheelEvent("wheel", { deltaY: 100, cancelable: true, bubbles: true });
      canvas.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(prevented).toBe(true);
  });

  test("zooming keeps the candle under the cursor where it is", async ({ page, context }) => {
    await open(page, context);
    const { box, plotW, cx, cy } = await geometry(page);
    await page.mouse.move(cx, cy);
    const initial = (await chartState(page)).count;
    await page.mouse.wheel(0, 500);
    await page.mouse.wheel(0, 500);
    await field(page, "count").toBeGreaterThan(initial);

    const fraction = 0.25; // a quarter of the way across the plot
    await page.mouse.move(box.x + plotW * fraction, cy);
    const before = await chartState(page);
    await page.mouse.wheel(0, -240);
    await field(page, "count").toBeLessThan(before.count);
    const after = await chartState(page);

    const anchorBefore = before.start + fraction * before.count; // index of the candle under the cursor
    const anchorAfter = after.start + fraction * after.count;
    expect(Math.abs(anchorAfter - anchorBefore)).toBeLessThanOrEqual(1.01);
  });
});

test.describe("scroll", () => {
  test("dragging pans by the dragged distance; Live appears only when scrolled back; the live edge is a hard limit", async ({ page, context }) => {
    await open(page, context);
    const { plotW, cx, cy } = await geometry(page);
    const step = plotW / (await chartState(page)).count; // pixels per candle
    await expect(liveButton(page)).toHaveCount(0);

    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 10 * step, cy, { steps: 5 });
    await page.mouse.up();
    await field(page, "offset").toBeCloseTo(10, 0);
    await expect(liveButton(page)).toHaveCount(1);

    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx - 50 * step, cy, { steps: 5 });
    await page.mouse.up();
    await field(page, "offset").toBe(0); // can't go past the newest candle
    await expect(liveButton(page)).toHaveCount(0);
  });

  test("a horizontal wheel swipe and shift+wheel also pan", async ({ page, context }) => {
    await open(page, context);
    const { plotW, cx, cy } = await geometry(page);
    const step = plotW / (await chartState(page)).count;
    await page.mouse.move(cx, cy);

    await page.mouse.wheel(60 * step, 0); // toward newer candles while already live: no movement
    expect((await chartState(page)).offset).toBe(0);
    await page.mouse.wheel(-30 * step, 0);
    await field(page, "offset").toBeGreaterThan(10);

    const scrolled = (await chartState(page)).offset;
    await page.keyboard.down("Shift");
    await page.mouse.wheel(0, 5 * step);
    await page.keyboard.up("Shift");
    await field(page, "offset").toBeLessThan(scrolled);
  });

  test("scrolling back loads older history in pages and stops at the start of the market", async ({ page, context }) => {
    const mock = await open(page, context);
    await chartCanvas(page).focus();

    let previous = 0;
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Home"); // jump to the oldest candle we hold; that triggers the next page
      await page.waitForTimeout(700);
      const { loaded } = await chartState(page);
      if (loaded === previous && mock.olderRequests().length >= 4) break;
      previous = loaded;
    }
    // 200 candles at first, then pages of 500: 700, 1200, 1700, and a short last page = the start of the market
    expect(mock.olderRequests()).toHaveLength(4);
    expect((await chartState(page)).loaded).toBe(HISTORY_MINUTES + 1);

    const requestsBefore = mock.requests.length;
    await page.keyboard.press("Home");
    await page.waitForTimeout(1500);
    expect(mock.requests.length, "no further requests once the start of history is reached").toBe(requestsBefore);

    const end = await chartState(page);
    expect(end.offset).toBe(end.loaded - Math.ceil(end.count * 0.25)); // the oldest candles reach the right quarter
  });

  test("a scrolled-back window stays anchored in time while new candles arrive; at the live edge it follows them", async ({ page, context }) => {
    const mock = await open(page, context);
    await chartCanvas(page).focus();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    const scrolled = await chartState(page);
    expect(scrolled.offset).toBeGreaterThan(0);

    mock.state.minuteShift = 1; // the exchange moves on to the next minute: one new candle at the right
    await field(page, "loaded").toBe(scrolled.loaded + 1);
    const afterNewCandle = await chartState(page);
    expect(afterNewCandle.start).toBeCloseTo(scrolled.start, 6); // same candles on screen...
    expect(afterNewCandle.offset).toBe(scrolled.offset + 1); // ...because the offset grew with the data

    await page.keyboard.press("End");
    await field(page, "offset").toBe(0);
    const live = await chartState(page);
    mock.state.minuteShift = 2;
    await field(page, "loaded").toBe(live.loaded + 1);
    const followed = await chartState(page);
    expect(followed.offset).toBe(0);
    expect(followed.start).toBe(live.start + 1); // the window moved with the newest candle
  });
});

test.describe("keyboard, buttons and resets", () => {
  test("Home / End / 0 and the +, -, arrow keys", async ({ page, context }) => {
    await open(page, context);
    await chartCanvas(page).focus();

    await page.keyboard.press("Home");
    await field(page, "offset").toBeGreaterThan(100); // far back
    await page.keyboard.press("End");
    await field(page, "offset").toBe(0);
    await page.keyboard.press("Home");
    await page.keyboard.press("0"); // 0 is also "back to live"
    await field(page, "offset").toBe(0);

    const count = (await chartState(page)).count;
    await page.keyboard.press("+");
    await field(page, "count").toBeLessThan(count);
    const zoomedIn = (await chartState(page)).count;
    await page.keyboard.press("-");
    await page.keyboard.press("-");
    await field(page, "count").toBeGreaterThan(zoomedIn);

    const { count: now } = await chartState(page);
    await page.keyboard.press("Shift+ArrowLeft"); // a full window back
    await expect.poll(async () => Math.abs((await chartState(page)).offset - now)).toBeLessThan(2);
  });

  test("zoom buttons, Live, Reset and double-click", async ({ page, context }) => {
    await open(page, context);
    await chartCanvas(page).focus();
    const auto = await defaultCandleCount(page);

    const count = (await chartState(page)).count;
    await page.getByRole("button", { name: "Zoom in" }).click();
    await field(page, "count").toBeLessThan(count);
    const zoomedIn = (await chartState(page)).count;
    await page.getByRole("button", { name: "Zoom out" }).click();
    await page.getByRole("button", { name: "Zoom out" }).click();
    await field(page, "count").toBeGreaterThan(zoomedIn);

    await chartCanvas(page).focus();
    await page.keyboard.press("Shift+ArrowLeft");
    await expect(liveButton(page)).toBeVisible();
    const zoomed = (await chartState(page)).count;
    await liveButton(page).click();
    expect(await chartState(page)).toMatchObject({ offset: 0, count: zoomed }); // back to newest, zoom kept

    await chartCanvas(page).focus();
    await page.keyboard.press("ArrowLeft");
    await resetButton(page).click();
    expect(await chartState(page)).toMatchObject({ offset: 0, count: auto }); // newest + automatic zoom

    await page.keyboard.press("+");
    await page.keyboard.press("ArrowLeft");
    const { cx, cy } = await geometry(page);
    await page.mouse.dblclick(cx, cy);
    await expect.poll(() => chartState(page)).toMatchObject({ offset: 0, count: auto }); // double-click resets
  });

  test("changing timeframe or symbol returns to the live edge but keeps the zoom", async ({ page, context }) => {
    await open(page, context);
    await chartCanvas(page).focus();
    await page.keyboard.press("+");
    await page.keyboard.press("+");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    const before = await chartState(page);
    expect(before.offset).toBeGreaterThan(0);
    expect(before.count).toBeLessThan(await defaultCandleCount(page));

    await clickTimeframe(page, "5m");
    await field(page, "loaded").toBe(300);
    expect(await chartState(page)).toMatchObject({ offset: 0, count: before.count });

    await chartCanvas(page).focus();
    await page.keyboard.press("Home"); // older history also loads on higher timeframes
    await field(page, "loaded").toBeGreaterThan(300);

    await page.getByText("ETHUSDT", { exact: true }).first().click();
    await field(page, "loaded").toBe(300);
    expect(await chartState(page)).toMatchObject({ offset: 0 });
  });
});

test.describe("touch", () => {
  /** Dispatch a synthetic touch pointer event on the canvas. */
  const touch = (page: Page, type: string, id: number, x: number, y: number) =>
    chartCanvas(page).evaluate(
      (canvas, a) =>
        canvas.dispatchEvent(new PointerEvent(a.type, { pointerId: a.id, pointerType: "touch", clientX: a.x, clientY: a.y, bubbles: true, isPrimary: a.id === 1, button: 0 })),
      { type, id, x, y }
    );

  test("one finger drags the chart", async ({ page, context }) => {
    await open(page, context);
    const { plotW, cx, cy } = await geometry(page);
    const step = plotW / (await chartState(page)).count;
    await touch(page, "pointerdown", 1, cx, cy);
    await touch(page, "pointermove", 1, cx + 7 * step, cy);
    await touch(page, "pointerup", 1, cx + 7 * step, cy);
    await field(page, "offset").toBeCloseTo(7, 0);
  });

  test("two fingers pinch to zoom", async ({ page, context }) => {
    await open(page, context);
    const { cx, cy } = await geometry(page);
    const initial = (await chartState(page)).count;

    // fingers move apart: zoom in
    await touch(page, "pointerdown", 1, cx - 100, cy);
    await touch(page, "pointerdown", 2, cx + 100, cy);
    await touch(page, "pointermove", 2, cx + 300, cy);
    await touch(page, "pointerup", 2, cx + 300, cy);
    await touch(page, "pointerup", 1, cx - 100, cy);
    await field(page, "count").toBeLessThan(initial);

    await resetButton(page).click();
    const reset = (await chartState(page)).count;
    // fingers move together: zoom out
    await touch(page, "pointerdown", 1, cx - 200, cy);
    await touch(page, "pointerdown", 2, cx + 200, cy);
    await touch(page, "pointermove", 2, cx + 50, cy);
    await touch(page, "pointerup", 2, cx + 50, cy);
    await touch(page, "pointerup", 1, cx - 200, cy);
    await field(page, "count").toBeGreaterThan(reset);
  });
});
