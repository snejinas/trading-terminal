import type { Page } from "@playwright/test";
import { expect, test } from "./support/test";
import { installMockBinance } from "./support/mockBinance";
import { cashText, logLines, openTerminal, runCommand } from "./support/terminal";

/**
 * Order book: 10 levels per side, 0.05 units each (0.5 visible), 10 bps apart, flat price. That makes
 * a 0.42 BTC order walk 9 levels and take 84% of the book, so every warning threshold is reachable.
 */
test.beforeEach(async ({ context, page }) => {
  await installMockBinance(context, { depth: { size: "0.05000", stepFraction: 0.001 } });
  await openTerminal(page);
});

const ticket = (page: Page) => page.locator("aside").last();
const quantity = (page: Page) => page.locator('input[inputmode="decimal"]').first();
const limitPrice = (page: Page) => page.locator('input[inputmode="decimal"]').nth(1);
const orderButton = (page: Page) => ticket(page).getByRole("button", { name: /^(BUY|SELL|Confirm|Not enough)/ }).last();
const alertBox = (page: Page) => ticket(page).getByRole("alert");
const slippageRow = (page: Page) => ticket(page).getByText("Est. slippage").locator("..");
const setQuantity = (page: Page, value: string) => quantity(page).fill(value);

test.describe("estimate and warnings", () => {
  test("a small order at the touch has no slippage and no warning", async ({ page }) => {
    await setQuantity(page, "0.01");
    await expect(slippageRow(page)).toContainText("0.0 bps · $0.00");
    await expect(alertBox(page)).toHaveCount(0);
    await expect(orderButton(page)).toHaveText("BUY 0.01 BTCUSDT");
  });

  test("walking two levels is just information", async ({ page }) => {
    await setQuantity(page, "0.1");
    await expect(slippageRow(page)).toContainText("5.0 bps · $3.40");
    await expect(alertBox(page)).toHaveCount(0);
  });

  test("a noticeable impact is a warning, but needs no confirmation", async ({ page }) => {
    await setQuantity(page, "0.3");
    await expect(slippageRow(page)).toContainText("25.0 bps · $51.00");
    await expect(alertBox(page)).toContainText("Noticeable price impact");
    await expect(alertBox(page)).toContainText("Walks 6 book levels: avg 68,170.50 vs best 68,000.50 (25.0 bps)");
    await expect(alertBox(page)).toContainText("Takes 60% of the visible ask liquidity");
    await expect(orderButton(page)).toHaveText("BUY 0.3 BTCUSDT"); // no warning sign
  });

  test("a high impact is flagged and marks the button", async ({ page }) => {
    await setQuantity(page, "0.42");
    await expect(slippageRow(page)).toContainText("37.1 bps · $106.08");
    await expect(alertBox(page)).toContainText("High price impact");
    await expect(alertBox(page)).toContainText("Takes 84% of the visible ask liquidity");
    await expect(orderButton(page)).toHaveText("BUY 0.42 BTCUSDT ⚠");
  });

  test("a market order bigger than the visible book is blocked", async ({ page }) => {
    await setQuantity(page, "50");
    await expect(alertBox(page)).toContainText("Not enough visible liquidity");
    await expect(alertBox(page)).toContainText("Only 0.5 of 50 is available");
    await expect(orderButton(page)).toHaveText("Not enough liquidity");
    await expect(orderButton(page)).toBeDisabled();
  });

  test("sells are analysed against the bids", async ({ page }) => {
    await runCommand(page, "buy BTCUSDT 0.45 !", 500); // build a position (severe, so confirmed with "!")
    await setQuantity(page, "0.4");
    await ticket(page).getByRole("button", { name: "SELL", exact: true }).first().click();
    await expect(slippageRow(page)).toContainText("35.0 bps");
    await expect(alertBox(page)).toContainText("High price impact");
    await expect(alertBox(page)).toContainText("Takes 80% of the visible bid liquidity");
    await expect(orderButton(page)).toHaveText("SELL 0.4 BTCUSDT ⚠");
  });

  test("a limit order shows only what is marketable now; one that doesn't cross shows no slippage", async ({ page }) => {
    await page.getByText("ETHUSDT", { exact: true }).first().click();
    await page.getByRole("button", { name: "Limit", exact: true }).click();
    await setQuantity(page, "0.2");

    await limitPrice(page).fill("2503"); // crosses two levels
    await expect(slippageRow(page)).toContainText("5.0 bps · $0.13");
    await expect(ticket(page)).toContainText("Walks 2 book levels");
    await expect(ticket(page)).toContainText("Only 0.1 is marketable now; the remaining 0.1 would rest as a limit order.");
    await expect(alertBox(page)).toHaveCount(0);

    await limitPrice(page).fill("2400"); // below the market: nothing executes now
    await expect(ticket(page).getByText("Est. slippage")).toHaveCount(0);
    await expect(alertBox(page)).toHaveCount(0);
  });
});

test.describe("confirming a high-impact order", () => {
  test("needs a second click, and any edit disarms it (even editing back)", async ({ page }) => {
    await setQuantity(page, "0.42");
    const cash = await cashText(page);

    await orderButton(page).click();
    await expect(orderButton(page)).toHaveText("Confirm BUY 0.42 BTCUSDT · ~37 bps");
    expect(await cashText(page), "the first click sends nothing").toBe(cash);

    await setQuantity(page, "0.41");
    await expect(orderButton(page)).toHaveText("BUY 0.41 BTCUSDT ⚠"); // editing disarmed it
    await setQuantity(page, "0.42");
    await orderButton(page).click();
    await expect(orderButton(page)).toHaveText("Confirm BUY 0.42 BTCUSDT · ~37 bps"); // armed again, not sent
    expect(await cashText(page)).toBe(cash);
  });

  test("the confirmation expires after a few seconds", async ({ page }) => {
    await setQuantity(page, "0.42");
    const cash = await cashText(page);
    await orderButton(page).click();
    await expect(orderButton(page)).toHaveText(/^Confirm/);
    await expect(orderButton(page)).toHaveText("BUY 0.42 BTCUSDT ⚠", { timeout: 9000 });
    expect(await cashText(page)).toBe(cash);
  });

  test("the second click sends it, and the fill matches the estimate", async ({ page }) => {
    await setQuantity(page, "0.42");
    const cash = await cashText(page);
    await orderButton(page).click();
    await orderButton(page).click();

    await expect.poll(() => logLines(page, /Filled: BUY 0\.42 BTCUSDT/)).toHaveLength(1);
    expect((await logLines(page, /Filled/))[0]).toMatch(/@ 68,253\.07 avg across 9 levels \(slippage 252\.57 · 37\.1 bps\)/);
    expect(await cashText(page)).not.toBe(cash);
  });
});

test("a fill uses up liquidity, so the next estimate is worse", async ({ page }) => {
  await runCommand(page, "buy BTCUSDT 0.42 !", 500);
  await setQuantity(page, "0.2");
  await expect(alertBox(page)).toContainText("Not enough visible liquidity"); // only ~0.08 (plus a little recovery) is left
  await expect(page.getByText(/net of your fills/)).toBeVisible();
});

test.describe("command line", () => {
  test("a high-impact order is not sent until it is repeated with '!'", async ({ page }) => {
    await runCommand(page, "buy ETHUSDT 0.4");
    expect(await logLines(page, /Not sent\. High price impact/)).toHaveLength(1);
    expect(await logLines(page, /Re-send with "!" to confirm: buy ETHUSDT 0\.4 !/)).toHaveLength(1);
    expect(await logLines(page, /Filled: BUY 0\.4 ETH/)).toHaveLength(0);

    await runCommand(page, "buy ETHUSDT 0.4 !", 500);
    const [fill] = await logLines(page, /Filled: BUY 0\.4 ETH/);
    expect(fill).toContain("@ 2,509.25 avg across 8 levels (slippage 8.75 · 35.0 bps)");
    expect(fill).toContain("fee 1.0037 (taker)");
  });

  test("'!' on an ordinary order is accepted and harmless", async ({ page }) => {
    await runCommand(page, "buy ETHUSDT 0.01 !", 500);
    expect(await logLines(page, /Filled: BUY 0\.01 ETH/)).toHaveLength(1);
  });
});
