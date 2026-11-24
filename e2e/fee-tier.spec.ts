import type { Page } from "@playwright/test";
import { expect, test } from "./support/test";
import { installMockBinance } from "./support/mockBinance";
import { headerText, logLines, openTerminal, reloadTerminal, runCommand } from "./support/terminal";

const feesButton = (page: Page) => page.getByRole("button", { name: /^Fees:/ });
const ticketFee = (page: Page) => page.getByText(/^Fee \(/).locator("..");
/** The ticket's fee row: label and amount are separate spans, so allow optional whitespace between them. */
const feeRow = (rate: string, amount: string) =>
  new RegExp(`^Fee \\(${rate.replace(/\./g, "\\.")}\\)\\s*\\$${amount.replace(/\./g, "\\.")}$`);

test.beforeEach(async ({ context, page }) => {
  await installMockBinance(context);
  await openTerminal(page);
});

test("starts on the regular tier (0.1% / 0.1%)", async ({ page }) => {
  await expect(feesButton(page)).toHaveText("Fees: Regular · 0.1% / 0.1%");
  await expect(ticketFee(page)).toHaveText(feeRow("0.1%", "0.6800")); // 0.01 BTC at 68,000.5
});

test("choosing VIP 3 changes the rates, the ticket and the next fill", async ({ page }) => {
  await feesButton(page).click();
  await page.getByRole("combobox").selectOption("vip3");
  await expect(feesButton(page)).toHaveText("Fees: VIP 3 · 0.042% / 0.06%");
  await expect(ticketFee(page)).toHaveText(feeRow("0.06%", "0.4080"));

  await runCommand(page, "buy ETHUSDT 1", 500); // 2,500.50 notional x 0.06% taker
  expect((await logLines(page, /Filled/))[0]).toContain("fee 1.5003 (taker)");
});

test("the BNB discount takes 25% off a tier", async ({ page }) => {
  await feesButton(page).click();
  await page.getByRole("combobox").selectOption("vip3");
  await page.getByRole("checkbox").check();
  await expect(feesButton(page)).toHaveText("Fees: VIP 3 + BNB · 0.0315% / 0.045%");
  await expect(ticketFee(page)).toHaveText(feeRow("0.045%", "0.3060"));
});

test("custom rates replace the tier (no BNB option) and are clamped to 2%", async ({ page }) => {
  await feesButton(page).click();
  await page.getByRole("combobox").selectOption("custom");
  await expect(page.getByText("Maker %")).toBeVisible();
  await expect(page.getByRole("checkbox")).toHaveCount(0);

  const [maker, taker] = await page.locator("input[type=number]").all();
  await maker.fill("0.02");
  await taker.fill("0.05");
  await expect(feesButton(page)).toHaveText("Fees: Custom · 0.02% / 0.05%");
  await expect(ticketFee(page)).toHaveText(feeRow("0.05%", "0.3400"));

  await taker.fill("999");
  await expect(feesButton(page)).toHaveText("Fees: Custom · 0.02% / 2%");
});

test("the popover closes on Escape and on an outside click", async ({ page }) => {
  await feesButton(page).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await feesButton(page).click();
  await page.mouse.click(300, 600);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("the choice survives a reload and applies to new fills", async ({ page }) => {
  await feesButton(page).click();
  await page.getByRole("combobox").selectOption("custom");
  const [maker, taker] = await page.locator("input[type=number]").all();
  await maker.fill("0.02");
  await taker.fill("0.05");
  await page.keyboard.press("Escape");

  await reloadTerminal(page);
  await expect(feesButton(page)).toHaveText("Fees: Custom · 0.02% / 0.05%");
  await expect(ticketFee(page)).toHaveText(feeRow("0.05%", "0.3400"));

  await runCommand(page, "buy ETHUSDT 1", 500); // 2,500.50 x 0.05%
  expect((await logLines(page, /Filled/))[0]).toContain("fee 1.2503 (taker)");
  expect(await headerText(page)).toContain("FEES PAID $1.25");
});

test("a corrupt saved setting falls back to the regular tier", async ({ page }) => {
  await page.evaluate(() =>
    localStorage.setItem("lifeinception.terminal.fees.v1", '{"tier":"hax","bnb":"yes","custom":{"maker":-3,"taker":"x"}}')
  );
  await reloadTerminal(page);
  await expect(feesButton(page)).toHaveText("Fees: Regular · 0.1% / 0.1%");
});
