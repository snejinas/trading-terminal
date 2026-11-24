import type { Page } from "@playwright/test";
import { expect, test } from "./support/test";
import { installMockBinance } from "./support/mockBinance";
import { cashText, headerText, logLines, openTerminal, reloadTerminal, runCommand } from "./support/terminal";

const ACCOUNT_KEY = "lifeinception.terminal.account.v1.binance";
const feesPaid = async (page: Page) => (await headerText(page)).match(/FEES PAID \$[\d.,]+/)![0];

test.describe("saved account", () => {
  test.beforeEach(async ({ context, page }) => {
    await installMockBinance(context);
    await openTerminal(page);
  });

  test("a reload restores cash, fees, the position and the working order", async ({ page }) => {
    await runCommand(page, "buy BTCUSDT 0.5");
    await runCommand(page, "buy ETHUSDT 2 2000"); // rests below the market
    const cash = await cashText(page);
    const fees = await feesPaid(page);
    expect(cash).not.toBe("100,000.00");

    await reloadTerminal(page);
    expect(await cashText(page)).toBe(cash);
    expect(await feesPaid(page)).toBe(fees);
    expect((await logLines(page, /Restored/))[0]).toContain("Restored your paper account: 1 fills, 1 positions, 1 working orders");

    await page.getByRole("button", { name: /^positions/i }).click();
    await expect(page.locator("table")).toContainText("BTCUSDT");
    await expect(page.locator("table")).toContainText("0.5");
    await page.getByRole("button", { name: /^orders/i }).click();
    await expect(page.locator("table")).toContainText("ETHUSDT");
    await expect(page.locator("table")).toContainText("2,000.00");
  });

  test("orders placed after a restore get fresh ids (no collisions)", async ({ page }) => {
    await runCommand(page, "buy ETHUSDT 2 2000");
    await reloadTerminal(page);
    await runCommand(page, "buy ETHUSDT 1 1900");
    await page.getByRole("button", { name: /^orders/i }).click();
    expect(await page.locator("tbody tr td:first-child").allInnerTexts()).toEqual(["#1", "#2"]);
  });

  test("a change in another tab shows up here", async ({ context, page }) => {
    await runCommand(page, "buy ETHUSDT 2 2000");
    await page.getByRole("button", { name: /^orders/i }).click();
    await expect(page.locator("table")).toContainText("ETHUSDT");

    const other = await context.newPage();
    await openTerminal(other);
    await runCommand(other, "cancel all");

    await expect(page.getByText("No working orders")).toBeVisible();
    await other.close();
  });

  test("corrupt saved data gives a fresh account instead of breaking the page", async ({ page }) => {
    await runCommand(page, "buy BTCUSDT 0.1");
    await page.evaluate((k) => localStorage.setItem(k, '{"v":1,"cash":"oops"'), ACCOUNT_KEY);
    await reloadTerminal(page);
    expect(await cashText(page)).toBe("100,000.00");
  });

  test("`reset` clears the saved account too", async ({ page }) => {
    await runCommand(page, "buy BTCUSDT 0.1");
    await runCommand(page, "reset");
    await reloadTerminal(page);
    expect(await cashText(page)).toBe("100,000.00");
  });
});

test("with browser storage blocked the terminal still trades", async ({ context, page }) => {
  await context.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new Error("blocked");
      },
    });
  });
  await installMockBinance(context);
  await openTerminal(page);

  await runCommand(page, "buy BTCUSDT 0.1", 600);
  expect(await cashText(page)).not.toBe("100,000.00");
  // (any page error would fail the test through the shared `pageErrors` fixture)
});
