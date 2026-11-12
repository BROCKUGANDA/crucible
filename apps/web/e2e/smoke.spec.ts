import { test, expect } from "playwright/test";

const pages = [
  "/",
  "/arena",
  "/trials",
  "/hall",
  "/escrow",
  "/forge",
  "/proofs",
  "/showcase",
  "/ghost",
  "/verify",
  "/scorecards",
];

for (const p of pages) {
  test(`smoke: ${p} renders without console errors`, async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error" && !msg.text().includes("ERR_CONNECTION_REFUSED")) errors.push(msg.text());
    });
    page.on("pageerror", (err) => errors.push(err.message));
    const res = await page.goto(p);
    expect(res?.status()).toBeLessThan(400);
    await expect(page.locator("main, body").first()).toBeVisible();
    // basic a11y: page has an h1
    await expect(page.locator("h1").first()).toBeVisible();
    expect(errors, `console errors on ${p}: ${errors.join("; ")}`).toEqual([]);
  });
}

test("a11y: skip link / landmark presence on home", async ({ page }) => {
  await page.goto("/");
  // main landmark
  await expect(page.locator("main")).toBeVisible();
  // at least one heading
  expect(await page.locator("h1, h2").count()).toBeGreaterThan(0);
});
