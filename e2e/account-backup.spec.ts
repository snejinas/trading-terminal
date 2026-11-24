import fs from "node:fs";
import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "./support/test";
import { installMockBinance } from "./support/mockBinance";
import { cashText, openTerminal, reloadTerminal, runCommand } from "./support/terminal";

test.beforeEach(async ({ context, page }) => {
  await installMockBinance(context);
  await openTerminal(page);
});

const dialog = (page: Page) => page.getByRole("dialog");

/** Export through the Backup menu; returns the saved file's path and parsed contents. */
async function exportViaMenu(page: Page, testInfo: TestInfo) {
  await page.getByRole("button", { name: "Backup" }).click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("menuitem", { name: /Export/ }).click()]);
  const file = testInfo.outputPath(download.suggestedFilename());
  await download.saveAs(file);
  return { file, name: download.suggestedFilename(), json: JSON.parse(fs.readFileSync(file, "utf8")) };
}

/** Pick a file through Backup > Import (the menu click opens the browser's file chooser). */
async function importViaMenu(page: Page, file: string) {
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByRole("button", { name: "Backup" }).click().then(() => page.getByRole("menuitem", { name: /Import/ }).click()),
  ]);
  await chooser.setFiles(file);
}

/** An account with a position and a resting order, so a backup has something in it. */
async function trade(page: Page) {
  await runCommand(page, "buy BTCUSDT 0.1");
  await runCommand(page, "buy ETHUSDT 2 2000");
}

test("exports the account as a JSON file", async ({ page }, testInfo) => {
  await trade(page);
  const { name, json } = await exportViaMenu(page, testInfo);

  expect(name).toMatch(/^paper-account-binance-\d{8}-\d{4}\.json$/);
  expect(json.kind).toBe("lifeinception-paper-account");
  expect(json.source).toBe("binance");
  expect(json.account.fills).toHaveLength(1);
  expect(json.account.orders).toHaveLength(1);
  expect(Object.keys(json.account.positions)).toEqual(["BTCUSDT"]);
  expect(JSON.stringify(json)).not.toMatch(/tier|rates/); // the fee tier is a setting, not part of a backup
});

test("importing asks first, can be cancelled, and replaces the account when confirmed", async ({ page }, testInfo) => {
  await trade(page);
  const cashBefore = await cashText(page);
  const { file } = await exportViaMenu(page, testInfo);

  await runCommand(page, "reset");
  expect(await cashText(page)).toBe("100,000.00");

  // the confirmation shows current vs backup
  await importViaMenu(page, file);
  await expect(dialog(page)).toContainText("Replace your paper account?");
  await expect(dialog(page)).toContainText("Binance feed");
  await expect(dialog(page)).toContainText("Positions");

  // Escape and Cancel both leave the account alone
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  expect(await cashText(page)).toBe("100,000.00");
  await importViaMenu(page, file);
  await dialog(page).getByRole("button", { name: "Cancel" }).click();
  await expect(dialog(page)).toHaveCount(0);
  expect(await cashText(page)).toBe("100,000.00");

  // confirming restores everything
  await importViaMenu(page, file);
  await dialog(page).getByRole("button", { name: "Replace account" }).click();
  await expect(dialog(page)).toHaveCount(0);
  expect(await cashText(page)).toBe(cashBefore);
  await page.getByRole("button", { name: /^positions/i }).click();
  await expect(page.locator("table")).toContainText("BTCUSDT");
  await page.getByRole("button", { name: /^orders/i }).click();
  await expect(page.locator("table")).toContainText("ETHUSDT");

  // ids continue after the imported ones, and the import is saved
  await runCommand(page, "buy ETHUSDT 1 1900");
  expect(await page.locator("tbody tr td:first-child").allInnerTexts()).toEqual(["#2", "#3"]);
  await reloadTerminal(page);
  expect(await cashText(page)).not.toBe("100,000.00");
});

const BAD_FILES: { name: string; message: RegExp; body: (good: any) => string }[] = [
  { name: "not json", message: /isn't valid JSON/, body: () => "hello world" },
  { name: "empty file", message: /isn't valid JSON/, body: () => "" },
  { name: "some other JSON", message: /doesn't look like a paper-account backup/, body: () => JSON.stringify({ kind: "other", version: 1 }) },
  { name: "backup from the simulated feed", message: /taken on the simulated feed, but you're on the Binance feed/, body: (g) => JSON.stringify({ ...g, source: "sim" }) },
  { name: "tampered account data", message: /invalid or corrupted/, body: (g) => JSON.stringify({ ...g, account: { ...g.account, cash: "rich" } }) },
];

for (const bad of BAD_FILES) {
  test(`rejects a bad file (${bad.name}) and leaves the account untouched`, async ({ page }, testInfo) => {
    await trade(page);
    const cash = await cashText(page);
    const { json } = await exportViaMenu(page, testInfo);
    const file = testInfo.outputPath("bad.json");
    fs.writeFileSync(file, bad.body(json));

    await importViaMenu(page, file);
    await expect(dialog(page)).toContainText("Couldn't import");
    await expect(dialog(page)).toContainText(bad.message);
    await dialog(page).getByRole("button", { name: "Close" }).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(await cashText(page)).toBe(cash);
  });
}

test("`export` and `import` commands work, and the dialog can back up the current account first", async ({ page }, testInfo) => {
  await trade(page);
  const { file } = await exportViaMenu(page, testInfo);

  const [download] = await Promise.all([page.waitForEvent("download"), runCommand(page, "export")]);
  expect(download.suggestedFilename()).toMatch(/^paper-account-binance-/);

  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), runCommand(page, "import")]);
  await chooser.setFiles(file);
  const [safetyCopy] = await Promise.all([
    page.waitForEvent("download"),
    dialog(page).getByRole("button", { name: "Back up current first" }).click(),
  ]);
  expect(safetyCopy.suggestedFilename()).toMatch(/^paper-account-binance-/);
  await page.keyboard.press("Escape");
});
