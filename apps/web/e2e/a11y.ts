import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

// WCAG 2.2 AA, which covers what this design can get wrong: contrast (thin type, grey labels) and tap targets.
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/** Fails with each violation (rule, impact, and the elements) if the page as it stands breaks WCAG 2.2 AA. */
export async function expectAccessible(page: Page, where: string) {
  // Let entrance animations settle (some are staggered): a fading element measures at its in-between contrast.
  // Endless ones (a pulsing dot) are left out; the clock's bar restarts each second, so this polls for a gap.
  await page.waitForFunction(() => document.getAnimations()
    .every((a) => a.playState !== "running" || a.effect?.getTiming().iterations === Infinity), undefined, { timeout: 5_000 })
    .catch(() => {});
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const report = violations.map((v) =>
    `${v.id} (${v.impact}): ${v.help}\n${v.nodes.slice(0, 5).map((n) => `  ${n.target.join(" ")}: ${n.failureSummary?.split("\n").slice(1).join(" ")}`).join("\n")}`);
  expect(report, `accessibility on ${where}`).toEqual([]);
}
