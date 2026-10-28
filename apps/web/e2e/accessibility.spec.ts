import { devices, test } from "@playwright/test";

import { expectAccessible } from "./a11y";

// The pages anyone can open, on a phone and (for /tv) a TV-sized screen. The lobby and game screens are checked
// inside the lobby and quiz tests, where there's a room to show.

for (const path of ["/", "/join", "/login"]) {
  test(`${path} meets WCAG 2.2 AA on a phone`, async ({ browser }) => {
    const context = await browser.newContext({ ...devices["Pixel 7"] });
    const page = await context.newPage();
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    await expectAccessible(page, path);
    await context.close();
  });
}

test("/tv meets WCAG 2.2 AA on a TV", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  await page.goto("/tv");
  await page.getByTestId("pairing-code").filter({ hasText: /^[A-Z0-9]{6}$/ }).waitFor();
  await expectAccessible(page, "/tv");
  await context.close();
});
