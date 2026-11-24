import { expect, test as base } from "@playwright/test";

/**
 * `test` with one extra guarantee: any uncaught page error or console error during a test fails it.
 * (Failed network requests are ignored: several tests deliberately abort Binance requests.)
 */
export const test = base.extend<{ pageErrors: string[] }>({
  pageErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (m) => {
        if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text());
      });
      await use(errors);
      expect(errors, "uncaught page / console errors").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
