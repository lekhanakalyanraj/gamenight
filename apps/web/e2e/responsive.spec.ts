import { expect, type Page, test } from "@playwright/test";

import { expectAccessible } from "./a11y";

// Every screen fits every device: phones from 360 px, tablets, laptops, and TVs up to 4K. Nothing scrolls sideways,
// nothing's cut off, and each width still meets WCAG 2.2 AA. Screenshots go to test-results for a look by eye.

const PHONES = [{ width: 360, height: 780 }, { width: 412, height: 915 }];
const LARGER = [{ width: 768, height: 1024 }, { width: 1280, height: 800 }];
const TVS = [{ width: 1280, height: 720 }, { width: 1920, height: 1080 }, { width: 3840, height: 2160 }];

async function expectFits(page: Page, what: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, `${what} scrolls sideways`).toBeLessThanOrEqual(0);
}

for (const viewport of [...PHONES, ...LARGER]) {
  for (const path of ["/", "/join", "/login"]) {
    test(`${path} fits ${viewport.width} px`, async ({ browser }) => {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      await expectFits(page, `${path} at ${viewport.width} px`);
      await context.close();
    });
  }
}

for (const viewport of [...TVS, { width: 412, height: 915 }]) {
  test(`the TV's pairing screen fits ${viewport.width} x ${viewport.height}`, async ({ browser }) => {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    await page.goto("/tv");
    const code = page.getByTestId("pairing-code").filter({ hasText: /^[A-Z0-9]{6}$/ });
    await code.waitFor();
    await expectFits(page, `/tv at ${viewport.width} px`);
    // The code is the point of the screen: whole, on screen, and no smaller than the design's on a 1080p set.
    const box = await code.boundingBox();
    expect(box && box.y + box.height <= viewport.height, "the pairing code is on screen").toBe(true);
    const scale = Math.min(viewport.width / 1920, viewport.height / 1080);
    if (viewport.width > viewport.height) {
      const rootPx = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
      expect(rootPx, "the TV scales with the screen").toBeCloseTo(Math.max(8, Math.min(40, 16 * scale)), 0);
    }
    await expectAccessible(page, `/tv at ${viewport.width} px`);
    await page.screenshot({ path: test.info().outputPath(`tv-${viewport.width}.png`) });
    await context.close();
  });
}

test("the lobby is one column on a phone and a grid of cards on a laptop", async ({ browser }) => {
  const runId = crypto.randomUUID();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.goto("/login?next=/host");
  await page.getByRole("button", { name: "New here? Create a host account" }).click();
  await page.getByLabel("Your name").fill("Priya");
  await page.getByLabel("Email").fill(`e2e-grid-${runId.slice(0, 8)}@gamenight.test`);
  await page.getByLabel("Password").fill(`e2e-${runId}`);
  await page.getByRole("button", { name: "Create host account" }).click();
  await expect(page).toHaveURL(/\/host$/);
  await page.getByLabel("Your nickname in the game").fill("Priya");
  await page.getByRole("button", { name: "Create room" }).click();
  await expect(page).toHaveURL(/\/play\/[A-Z0-9]{6}$/);
  await page.getByRole("group", { name: "Quiz topics" }).getByRole("button", { name: "Anime", exact: true }).click();
  await expect(page.getByTestId("my-topic")).toHaveText("Anime");

  const players = page.getByText("Players", { exact: true }).first();
  const topics = page.getByText("Your Quiz Night topic", { exact: true });
  for (const viewport of [{ width: 1280, height: 900 }, { width: 768, height: 1024 }, { width: 412, height: 915 }, { width: 360, height: 780 }]) {
    await page.setViewportSize(viewport);
    await expectFits(page, `the lobby at ${viewport.width} px`);
    const [a, b] = [await players.boundingBox(), await topics.boundingBox()];
    const sideBySide = Boolean(a && b && Math.abs(a.x - b.x) > 100);
    expect(sideBySide, `cards side by side at ${viewport.width} px`).toBe(viewport.width >= 768);
    await expectAccessible(page, `the lobby at ${viewport.width} px`);
    await page.screenshot({ path: test.info().outputPath(`lobby-${viewport.width}.png`), fullPage: true });
  }
  await context.close();
});
