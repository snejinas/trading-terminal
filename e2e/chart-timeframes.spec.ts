import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "./support/test";
import { blockBinance, installMockBinance, type MockOptions } from "./support/mockBinance";
import {
  clickTimeframe,
  logLines,
  openTerminal,
  pressedTimeframes,
  reloadTerminal,
  runCommand,
  timeframeGroup,
} from "./support/terminal";

async function start(page: Page, context: BrowserContext, options?: MockOptions) {
  const mock = await installMockBinance(context, options);
  await openTerminal(page);
  return mock;
}

const pressed = (page: Page) => expect.poll(() => pressedTimeframes(page));

test("offers 1m, 5m, 15m, 1h, 4h and 1D, starting on 1m", async ({ page, context }) => {
  await start(page, context);
  await expect(timeframeGroup(page).getByRole("button")).toHaveText(["1m", "5m", "15m", "1h", "4h", "1D"]);
  expect(await pressedTimeframes(page)).toBe("1m");
});

test("fetches each timeframe once and serves repeats from the cache", async ({ page, context }) => {
  const mock = await start(page, context);

  await clickTimeframe(page, "1h");
  await pressed(page).toBe("1h");
  await expect.poll(() => mock.higherTimeframeRequests()).toEqual(["BTCUSDT/1h"]);

  await clickTimeframe(page, "5m");
  await clickTimeframe(page, "15m");
  await pressed(page).toBe("15m");
  await expect.poll(() => mock.higherTimeframeRequests()).toEqual(["BTCUSDT/1h", "BTCUSDT/5m", "BTCUSDT/15m"]);

  await clickTimeframe(page, "1h"); // already loaded
  await pressed(page).toBe("1h");
  await page.waitForTimeout(500);
  expect(mock.higherTimeframeRequests()).toEqual(["BTCUSDT/1h", "BTCUSDT/5m", "BTCUSDT/15m"]);
});

test("shows a loading state while a slow timeframe loads", async ({ page, context }) => {
  await start(page, context, { slowIntervals: { "1d": 1500 } });
  await clickTimeframe(page, "1D");
  await expect(timeframeGroup(page).getByText("loading…")).toBeVisible();
  await expect(timeframeGroup(page).getByText("loading…")).toHaveCount(0);
  await pressed(page).toBe("1D");
});

test("falls back to 1m, with a message, when a timeframe fails to load", async ({ page, context }) => {
  await start(page, context, { failIntervals: ["4h"] });
  await clickTimeframe(page, "4h");
  await pressed(page).toBe("1m");
  await expect.poll(() => logLines(page, /Couldn't load 4h candles for BTCUSDT/)).toHaveLength(1);
});

test("history is per symbol, and cached once loaded", async ({ page, context }) => {
  const mock = await start(page, context);
  await clickTimeframe(page, "1h");
  await expect.poll(() => mock.higherTimeframeRequests()).toEqual(["BTCUSDT/1h"]);

  await page.getByText("ETHUSDT", { exact: true }).first().click();
  await expect.poll(() => mock.higherTimeframeRequests()).toEqual(["BTCUSDT/1h", "ETHUSDT/1h"]);
  expect(await pressedTimeframes(page)).toBe("1h"); // the timeframe stays

  await page.getByText("BTCUSDT", { exact: true }).first().click(); // BTC/1h is cached
  await page.waitForTimeout(600);
  expect(mock.higherTimeframeRequests()).toEqual(["BTCUSDT/1h", "ETHUSDT/1h"]);
});

test("remembers the chosen timeframe across a reload", async ({ page, context }) => {
  await start(page, context);
  await clickTimeframe(page, "15m");
  await reloadTerminal(page);
  expect(await pressedTimeframes(page)).toBe("15m");
});

test("`tf` and `chart SYMBOL TIMEFRAME` commands", async ({ page, context }) => {
  await start(page, context);

  await runCommand(page, "tf 5m");
  await pressed(page).toBe("5m");
  await runCommand(page, "tf 1D"); // case-insensitive, matches the label
  await pressed(page).toBe("1D");

  await runCommand(page, "chart SOLUSDT 1h");
  await pressed(page).toBe("1h");
  await expect(page.locator("span.text-lg.font-bold").first()).toHaveText("SOLUSDT");

  await runCommand(page, "tf 2h"); // not a timeframe
  expect(await logLines(page, /Usage: tf 1m \| 5m \| 15m \| 1h \| 4h \| 1D/)).toHaveLength(1);
  expect(await pressedTimeframes(page)).toBe("1h");

  await runCommand(page, "chart BTCUSDT 99x");
  expect(await logLines(page, /Unknown timeframe "99x"/)).toHaveLength(1);

  await runCommand(page, "help");
  expect(await logLines(page, /tf TIMEFRAME/)).toHaveLength(1);
});

test("trading is unaffected by the chart timeframe", async ({ page, context }) => {
  await start(page, context);
  await runCommand(page, "tf 1D");
  await runCommand(page, "buy BTCUSDT 0.01", 500);
  expect((await logLines(page, /Filled: BUY 0\.01/))[0]).toContain("BTCUSDT");
});

test("the simulated feed (Binance unreachable) offers 3s to 5m", async ({ page, context }) => {
  await blockBinance(context);
  await openTerminal(page);
  await expect(timeframeGroup(page).getByRole("button")).toHaveText(["3s", "15s", "30s", "1m", "5m"]);
  expect(await pressedTimeframes(page)).toBe("3s");

  await clickTimeframe(page, "5m");
  await pressed(page).toBe("5m");
  await clickTimeframe(page, "15s");
  await pressed(page).toBe("15s");
});
