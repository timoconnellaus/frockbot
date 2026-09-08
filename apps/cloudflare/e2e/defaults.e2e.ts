// The platform model makes the first Bot usable without a setup detour.
import type { Locator, Page } from "@playwright/test";
import {
  composerInput,
  createBot,
  expect,
  openApplication,
  sem,
  SHELL_TIMEOUT_MS,
  test,
  transcriptMessages,
} from "./fixtures.ts";

/**
 * Press a named widget.
 *
 * A `Semantics(identifier:)` around a widget that lays itself out reaches the
 * accessibility tree as a container with `pointer-events: none`, and the node
 * that takes the tap is its child — which is also the node that disappears
 * when the widget is disabled. Clicking the identifier itself would land on
 * the canvas behind it.
 */
function tap(scope: Page | Locator, identifier: string) {
  const node = `[flt-semantics-identifier="${identifier}"]`;
  return scope.locator(`${node}[flt-tappable], ${node} [flt-tappable]`).first();
}

/**
 * Words the product shows, wherever the engine put them.
 *
 * Flutter writes a leaf's words as text content but a merged node's — a titled
 * group, a live region, a switch — as its accessible name, and which of the
 * two a given sentence lands in is the engine's business rather than the
 * product's.
 */
function says(scope: Page | Locator, text: string) {
  return scope.locator(`[aria-label*="${text}"]`).or(scope.getByText(text));
}

/**
 * Say something and wait for the answer to be in the thread.
 *
 * The composer keeps the draft until the submission is accepted, so an empty
 * composer — and not a click that returned — is the signal that the Turn was
 * admitted. What it produces arrives over the Bot's state channel, and a
 * channel that drops leaves the thread holding its optimistic row for as long
 * as the page stays open; a reload reads the conversation back from the
 * authority, which is where the Turn is durable anyway.
 */
async function sendMessage(page: Page, text: string): Promise<void> {
  const composer = composerInput(page);
  // Focusing a Flutter text field replaces the DOM input the semantics tree
  // was holding, so a fill issued in the same breath as the click writes to a
  // node the engine has already discarded and the draft stays empty — which
  // leaves the send button disabled, and disabled means no tappable node at
  // all. The whole gesture is retried until the button is there to press.
  await expect(async () => {
    await composerInput(page).click();
    await page.waitForTimeout(300);
    await composerInput(page).fill(text);
    await expect(tap(page, "send-button")).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 120_000 });
  await tap(page, "send-button").click();
  await expect(composer).toHaveValue("", { timeout: 120_000 });
  await expect(transcriptMessages(page).first()).toBeVisible({
    timeout: 120_000,
  });
  let watched = true;
  await expect(async () => {
    if (!watched) {
      await page.reload();
      await expect(
        sem(page, "shell-sidebar").or(sem(page, "sidebar-toggle")),
      ).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    }
    watched = false;
    await expect(transcriptMessages(page)).toHaveCount(2, { timeout: 20_000 });
  }).toPass({ timeout: 540_000 });
}

test("a fresh User's Bot answers with zero configuration and no model prompt", async ({
  page,
  userId,
}) => {
  // A Turn on the platform model is more than the default budget allows on a
  // loaded machine.
  test.slow();
  await openApplication(page, userId);
  await createBot(page, "Ready");

  // Nothing on the way in asks which model to use: the platform model is
  // already behind the Bot, and the empty thread invites work instead.
  await expect(says(page, "Choose a model")).toHaveCount(0);
  await expect(page.getByText("What would you like to work on?")).toBeVisible();
  await expect(composerInput(page)).toBeEnabled();

  // The Bot answers, on a model nobody chose for it. What it says is the
  // provider's business rather than this test's — in CI the platform model is
  // a stub that writes the same sentence every time, and on a developer's
  // machine the same account setting reaches the real Frock AI — so the claim
  // is that the answer is there, beside the question, and that nothing refused
  // the Turn for want of a model.
  await sendMessage(page, "Answer with the platform model");
  await expect(transcriptMessages(page)).toHaveCount(2);
  await expect(says(page, "finish its reply")).toHaveCount(0);
  await expect(says(page, "Choose a model")).toHaveCount(0);
});
