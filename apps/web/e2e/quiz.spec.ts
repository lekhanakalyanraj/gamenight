import { type Browser, type BrowserContext, devices, expect, type Locator, type Page, test } from "@playwright/test";

// Slice 5c's "done when": a TV and five phones play a whole Quiz Night on the scripted quiz master (the same
// pipeline as production: dispatcher, Agent Server, narrator), every phone answering from its own screen, and
// no screen learns an answer before its reveal: not in what it shows, and not in what Realtime sends it.

type Phone = { name: string; context: BrowserContext; page: Page };

/**
 * Every Realtime message a page receives that carries quiz questions, as JSON, for the leak check at the end.
 * Broadcasts arrive in Realtime's binary framing (kind 4: a 5-byte header with the sizes of the topic, event
 * and metadata that follow, then the JSON payload); other messages are plain JSON text.
 */
function recordFrames(page: Page, frames: string[]) {
  page.on("websocket", (ws) => ws.on("framereceived", ({ payload }) => {
    let text = typeof payload === "string" ? payload : "";
    if (typeof payload !== "string" && payload[0] === 4) {
      text = payload.subarray(5 + payload[1] + payload[2] + payload[3]).toString("utf8");
    }
    if (text.includes("quiz_questions")) frames.push(text);
  }));
}

function watchCsp(page: Page, violations: string[]) {
  page.on("console", (msg) => {
    if (/Content Security Policy|Refused to (load|execute|connect|apply)/i.test(msg.text())) violations.push(msg.text());
  });
}

async function newPhone(browser: Browser, name: string, violations: string[], frames: string[]): Promise<Phone> {
  const context = await browser.newContext({ ...devices["Pixel 7"] });
  const page = await context.newPage();
  watchCsp(page, violations);
  recordFrames(page, frames);
  return { name, context, page };
}

async function tapIfShown(target: Locator): Promise<boolean> {
  if (!(await target.isVisible())) return false;
  try {
    await target.click({ timeout: 2_000 });
    return true;
  } catch {
    return false;
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A screen's text while a question is open, leaving out a reveal or round intro animating in beside it (as the
 * question animates out, the reveal is already rendering: its answer is public by then). Early answers in what a
 * screen receives are checked separately, on every Realtime message.
 */
async function openText(page: Page): Promise<string> {
  return page.evaluate(() => {
    let text = document.body.innerText;  // as laid out (textContent would run neighbouring numbers together)
    document.querySelectorAll<HTMLElement>('[data-testid="tv-reveal"], [data-testid="reveal"], [data-testid="round-intro"]')
      .forEach((e) => {
        text = text.replace(e.innerText, "");
      });
    return text;
  });
}

/** Every quiz_questions row inside a Realtime message (they nest a few levels deep). */
function questionRows(value: unknown, found: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) for (const v of value) questionRows(v, found);
  else if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (o.table === "quiz_questions" && o.record && typeof o.record === "object") found.push(o.record as Record<string, unknown>);
    for (const v of Object.values(o)) questionRows(v, found);
  }
  return found;
}

test("a TV and five phones play a whole quiz, and no answer shows before its reveal", async ({ browser }) => {
  test.setTimeout(480_000);
  const cspViolations: string[] = [];
  const frames: string[] = [];

  const tvContext = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const tv = await tvContext.newPage();
  watchCsp(tv, cspViolations);
  recordFrames(tv, frames);
  await tv.goto("/tv");
  const pairingCode = tv.getByTestId("pairing-code");
  await expect(pairingCode).toHaveText(/^[A-HJ-NP-Z2-9]{6}$/, { timeout: 30_000 });
  const tvCode = (await pairingCode.textContent()) ?? "";

  const host = await newPhone(browser, "Priya", cspViolations, frames);
  const runId = crypto.randomUUID();
  await host.page.goto("/login?next=/host");
  await host.page.getByRole("button", { name: "New here? Create a host account" }).click();
  await host.page.getByLabel("Your name").fill("Priya");
  await host.page.getByLabel("Email").fill(`e2e-quiz-${runId.slice(0, 8)}@gamenight.test`);
  await host.page.getByLabel("Password").fill(`e2e-${runId}`);
  await host.page.getByRole("button", { name: "Create host account" }).click();
  await expect(host.page).toHaveURL(/\/host$/);
  await host.page.getByLabel("Your nickname in the game").fill("Priya");
  await host.page.getByRole("button", { name: "Create room" }).click();
  await expect(host.page).toHaveURL(/\/play\/[A-Z0-9]{6}$/);
  await host.page.getByLabel("TV code").fill(tvCode);
  await host.page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(tv).toHaveURL(/\/tv\/[A-Z0-9]{6}$/);
  const joinUrl = (await tv.getByTestId("join-qr").getAttribute("data-join-url")) ?? "";

  const phones: Phone[] = [host];
  for (const name of ["Asha", "Ben", "Chen", "Dara"]) {
    const guest = await newPhone(browser, name, cspViolations, frames);
    await guest.page.goto(joinUrl);
    await guest.page.getByLabel("Your nickname").fill(name);
    await guest.page.getByRole("button", { name: "Join the room" }).click();
    await expect(guest.page).toHaveURL(/\/play\/[A-Z0-9]{6}$/);
    phones.push(guest);
  }

  // Topics: four pick one (a chip, or typed), one doesn't; the TV shows each next to its player.
  const topics: Record<string, string> = { Priya: "Cricket", Asha: "Geography", Ben: "Science", Chen: "music & film" };
  for (const phone of phones) {
    const topic = topics[phone.name];
    if (!topic) continue;
    const chip = phone.page.getByRole("group", { name: "Quiz topics" }).getByRole("button", { name: topic, exact: true });
    if (await chip.isVisible()) await chip.click();
    else {
      await phone.page.getByLabel("Your own topic").fill(topic);
      await phone.page.getByRole("button", { name: "Pick", exact: true }).click();
    }
    await expect(phone.page.getByTestId("my-topic")).toHaveText(topic);
  }
  await expect(tv.getByTestId("player-topic")).toHaveCount(4);

  // The host picks Quiz Night: 3 rounds (multiple choice, pictures, estimates), 10 seconds a question.
  await host.page.getByRole("tab", { name: "Quiz Night" }).click();
  await expect(host.page.getByText("4 of 5 picked a topic.", { exact: false })).toBeVisible();
  await host.page.getByRole("button", { name: "3", exact: true }).click();
  await host.page.getByRole("button", { name: "10 seconds" }).click();
  await host.page.getByRole("button", { name: "Start Quiz Night" }).click();
  await expect(tv.getByTestId("quiz-tv")).toBeVisible({ timeout: 30_000 });
  for (const phone of phones) await expect(phone.page.getByTestId("quiz-phone")).toBeVisible();

  const seenBefore = new Map<number, string[]>(); // question number -> screen text while it was open
  const answers = new Map<number, string>(); // question number -> the answer the TV revealed
  const kinds = new Map<number, string>();
  let pictureShown = false;
  let paused = false;
  let reloaded = false;
  let jokerPlayed = false;

  const deadline = Date.now() + 420_000;
  // Until the podium: the game ends the moment the last question is revealed, and its answer shows first.
  while (!(await tv.getByTestId("final-scores").isVisible())) {
    expect(Date.now(), "the quiz should finish").toBeLessThan(deadline);
    // Reads in this loop time out quickly: the screen may move on between looking and reading, which is fine.
    const number = Number(await tv.getByTestId("quiz-tv").getAttribute("data-number", { timeout: 2_000 }).catch(() => 0));
    const tvReveal = tv.getByTestId("tv-reveal");

    if (await tvReveal.isVisible()) {
      const answer = await tv.getByTestId("quiz-answer").first().getAttribute("data-answer", { timeout: 2_000 })
        .catch(() => null);
      if (answer && !answers.has(number)) answers.set(number, answer);
    } else if (await tv.getByTestId("tv-question").isVisible()) {
      // Before its reveal, nothing on any screen marks the right answer.
      const texts = seenBefore.get(number) ?? [];
      texts.push(await openText(tv));
      // (Within the question itself: as it animates out, the reveal is already rendering beside it.)
      expect(await tv.getByTestId("tv-question").locator("[data-correct]").count(), "the TV marked an answer before the reveal").toBe(0);
      if (await tv.getByTestId("quiz-picture").isVisible()) {
        expect(await tv.getByTestId("quiz-picture").getAttribute("src", { timeout: 2_000 }).catch(() => "blob:")).toMatch(/^blob:/);
        pictureShown = true;
      }
      const header = await tv.locator("header p").first().innerText({ timeout: 2_000 }).catch(() => "");
      if (header) kinds.set(number, header.split("·").pop()?.trim() ?? "");
      seenBefore.set(number, texts);
    }

    for (const phone of phones) {
      const { page, name } = phone;
      if (!(await page.getByTestId("quiz-phone").isVisible())) continue;
      const question = page.getByTestId("question");
      if (!(await question.isVisible())) continue;
      seenBefore.get(number)?.push(await openText(page));
      expect(await question.locator("[data-correct]").count(), `${name}'s phone marked an answer before the reveal`).toBe(0);

      // The host pauses once mid-question; the TV says so until they resume.
      if (name === "Priya" && !paused) {
        paused = true;
        await page.getByRole("button", { name: "Host controls" }).click();
        await page.getByRole("button", { name: "Pause" }).click();
        await expect(tv.getByText("Paused by the host")).toBeVisible();
        await page.getByRole("button", { name: "Resume" }).click();
        await expect(tv.getByText("Paused by the host")).toBeHidden();
        await page.getByRole("button", { name: "Close host controls" }).click();
      }

      // Ben's phone reloads mid-question once: it must come back to the same question, still able to answer.
      if (name === "Ben" && !reloaded && number > 1) {
        reloaded = true;
        await page.reload();
        await expect(page.getByTestId("quiz-phone")).toBeVisible({ timeout: 30_000 });
        continue;
      }

      if (await tapIfShown(page.getByTestId("joker"))) jokerPlayed = true;
      if (await page.getByTestId("estimate").isVisible()) {
        await page.getByLabel("Your estimate").fill(name === "Dara" ? "3" : "7");
        await tapIfShown(page.getByRole("button", { name: "Lock it in" }));
      } else {
        const tiles = page.getByTestId("answer-tile");
        const count = await tiles.count();
        if (count > 0) await tapIfShown(tiles.nth((name.charCodeAt(0) + number) % count));
      }
    }
    await tv.waitForTimeout(250);
  }

  // The end: a podium on the TV and every phone, and the same scores everywhere.
  await expect(tv.getByTestId("final-scores")).toBeVisible();
  await expect(tv.getByTestId("final-player")).toHaveCount(5);
  await expect(tv.getByTestId("podium-place")).toHaveCount(3);
  const tvScores = new Map<string, string>();
  for (const row of await tv.getByTestId("final-player").all()) {
    const cells = (await row.innerText()).split("\n").map((c) => c.trim()).filter(Boolean);
    tvScores.set(cells[1], cells[2]);
  }
  for (const phone of phones) {
    await expect(phone.page.getByTestId("final-scores")).toBeVisible({ timeout: 30_000 });
    const line = await phone.page.getByText(/^You finished /).innerText();
    expect(line, `${phone.name}'s total`).toContain(`with ${tvScores.get(phone.name)} points`);
  }

  // Every question was revealed, and nothing showed its answer before then.
  expect(answers.size, "every question's answer was revealed on the TV").toBe(15);
  for (const [number, answer] of answers) {
    if (!/estimate/i.test(kinds.get(number) ?? "")) continue; // the options are on screen by design; checked by [data-correct]
    const value = answer.split(" ")[0];
    for (const text of seenBefore.get(number) ?? []) {
      expect(new RegExp(`(^|[^\\d.,])${escapeRegExp(value)}([^\\d]|$)`).test(text),
             `question ${number}'s answer (${value}) was on a screen before its reveal`).toBe(false);
    }
  }

  // And no Realtime message ever carried an answer before its reveal.
  const rows = frames.flatMap((f) => {
    try {
      return questionRows(JSON.parse(f));
    } catch {
      return [];
    }
  });
  expect(rows.length).toBeGreaterThan(15);
  for (const row of rows) {
    expect(row.answer === null, `question ${String(row.number)} sent with an answer before its reveal`).toBe(row.revealed_at === null);
  }

  expect(pictureShown && paused && reloaded, "a picture, the pause and the reload all happened").toBe(true);
  expect(jokerPlayed, "the last-placed player played the joker going into the final round").toBe(true);
  expect(cspViolations, "the quiz screens run under the strict CSP").toEqual([]);

  // Play again: the host goes back to the lobby, ready to start another game.
  await host.page.getByRole("button", { name: "Play again" }).click();
  await expect(host.page.getByRole("button", { name: "Start Undercover" })).toBeVisible();
});
