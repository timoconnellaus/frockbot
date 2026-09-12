// The phone layout.
//
// The hosted WebUI is the product UI on every platform (`AGENTS.md`, "One
// production path"), so the phone is not a separate client: it is this same
// Flutter bundle at a 390pt viewport. Below 640 the shell is one column
// (`apps/native/lib/shell/desktop_layout.dart`): the Bot list is the first
// screen, a conversation is a page over it, and everything the right panel
// held is a page too — and this spec measures what that costs rather than
// eyeballing it.
//
// What it measures is different from what the Vue spec measured, because a
// canvas has no layout to interrogate: there is no document to overflow, no
// scrim element to outlive its panel, and no computed padding to read. What
// there is instead is the accessibility tree, and every node in it carries the
// box the engine drew it at — so "nothing is wider than the window" is asked
// of every widget on screen, one by one, which is closer to the question than
// a document scroll width ever was.
//
// It also writes the screenshots that stand as the visual record of the
// layout, into Playwright's output directory.
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  test,
  expect,
  composerInput,
  provisionThroughUi,
  sem,
  sendMessage,
  setFakeOllamaChatMode,
} from "./fixtures.ts";
import { E2E_OLLAMA_GOOD_API_KEY } from "./harness.ts";
import type { Page } from "@playwright/test";

/** A 2019-and-later iPhone in portrait: the narrowest viewport worth serving. */
const PHONE = { width: 390, height: 844 } as const;

test.use({ viewport: PHONE, deviceScaleFactor: 2, hasTouch: true });

const shotDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "test-results",
  "mobile",
);

async function shot(page: Page, name: string): Promise<void> {
  await mkdir(shotDirectory, { recursive: true });
  await page.screenshot({ path: join(shotDirectory, `${name}.png`) });
}

/**
 * Nothing the engine drew is wider than the window.
 *
 * A phone layout fails first as content that runs off the right edge: one
 * region that kept its desktop width, or a label that will not wrap. Every
 * named widget currently in the accessibility tree is asked where it is, which
 * covers the regions and the controls in them at once. A widget that is
 * deliberately off-canvas is not in the tree at all — a parked drawer is built
 * behind `ExcludeSemantics` — so nothing here has to make an exception for it.
 *
 * Measured until it settles rather than once. A page arrives over the one
 * below it on a slide — a Cupertino slide wherever the engine takes the host
 * for an Apple platform — and a single read taken while that transition is
 * still running catches the incoming page a few pixels short of home: the
 * whole page reported as five pixels off the right edge, which is a frame of
 * an animation rather than the layout this is asking about.
 */
async function expectNothingRunsOffTheEdge(page: Page): Promise<void> {
  const measure = (width: number) =>
    page.evaluate((limit) => {
      const wide: { id: string; left: number; right: number }[] = [];
      for (const node of document.querySelectorAll(
        "[flt-semantics-identifier]",
      )) {
        const box = node.getBoundingClientRect();
        if (box.width === 0 && box.height === 0) continue;
        if (box.left < -1 || box.right > limit + 1) {
          wide.push({
            id: node.getAttribute("flt-semantics-identifier") ?? "?",
            left: Math.round(box.left),
            right: Math.round(box.right),
          });
        }
      }
      return wide;
    }, width);
  await expect
    .poll(() => measure(PHONE.width), {
      message: "these widgets run off the side of the window",
      timeout: 10_000,
    })
    .toEqual([]);
}

/** Every part of a named widget is inside the window. */
async function expectWithinViewport(
  page: Page,
  identifier: string,
): Promise<void> {
  const box = await sem(page, identifier).first().boundingBox();
  expect(box, `${identifier} has no box`).not.toBeNull();
  if (!box) return;
  expect(
    box.x,
    `${identifier} starts left of the window`,
  ).toBeGreaterThanOrEqual(-1);
  expect(
    box.x + box.width,
    `${identifier} runs past the right edge`,
  ).toBeLessThanOrEqual(PHONE.width + 1);
  expect(box.y, `${identifier} starts above the window`).toBeGreaterThanOrEqual(
    -1,
  );
  expect(
    box.y + box.height,
    `${identifier} runs below the bottom edge`,
  ).toBeLessThanOrEqual(PHONE.height + 1);
}

/** Back to the Bot list from a conversation, and prove it arrived. */
async function openBots(page: Page): Promise<void> {
  await sem(page, "sidebar-toggle").click();
  await expect(sem(page, "shell-sidebar")).toBeVisible();
  await expect(sem(page, "shell-conversation")).toHaveCount(0);
}

/** Into a Bot's conversation from the list, which is the only way in. */
async function openConversation(page: Page, name: string): Promise<void> {
  await sem(page, "shell-sidebar")
    .locator('[flt-semantics-identifier^="sidebar-bot-"]')
    .filter({ hasText: name })
    .click();
  await expect(sem(page, "shell-sidebar")).toHaveCount(0);
  await expect(composerInput(page)).toBeVisible();
}

test("the shell is usable on a phone", async ({
  page,
  userId,
  ollamaBaseUrl,
}) => {
  // `provisionThroughUi` opens a wide window of its own to walk the Plugins
  // document and gives this one back, so everything below is at 390x844.
  await provisionThroughUi(page, {
    userId,
    apiKey: E2E_OLLAMA_GOOD_API_KEY,
    apiBaseUrl: ollamaBaseUrl,
    botName: "Pocket",
  });

  // One column: the conversation just opened has the window, and the way
  // back to the list is in its bar rather than a drawer beside it.
  await expect(sem(page, "sidebar-toggle")).toBeVisible();
  await expect(sem(page, "shell-sidebar")).toHaveCount(0);
  await expect(composerInput(page)).toBeVisible();
  await shot(page, "01-empty-thread");
  await expectNothingRunsOffTheEdge(page);
  await expectWithinViewport(page, "chat-composer");
  // An empty composer offers dictation; the send control takes its place
  // once there is something to send.
  await expectWithinViewport(page, "composer-dictate");
  // GrokBot's bar: the way back, the Bot, the Computer. Nothing else is a
  // control up here; Routines and Applets are rows on the Bot's page.
  await expect(sem(page, "bot-panel-toggle")).toBeVisible();
  await expect(page.getByRole("button", { name: "Routines" })).toHaveCount(0);

  // The list is a screen of its own, with the list's controls on it — and
  // the Marketplace beside the avatar, where a phone keeps it.
  await openBots(page);
  await shot(page, "02-bot-list");
  await expectNothingRunsOffTheEdge(page);
  await expectWithinViewport(page, "shell-sidebar");
  await expectWithinViewport(page, "sidebar-profile");
  await expectWithinViewport(page, "sidebar-marketplace");
  await expectWithinViewport(page, "sidebar-search");
  await expectWithinViewport(page, "sidebar-create-bot");
  await openConversation(page, "Pocket");

  // The fake provider's chat mode is one piece of state the whole suite
  // shares, and a spec before this one may have revoked the key to prove a
  // failing Turn. Say what this spec needs rather than inherit it.
  await setFakeOllamaChatMode(page, ollamaBaseUrl, "ok");
  await sendMessage(page, "Does this **fit** on a phone?");
  await shot(page, "03-conversation");
  await expectNothingRunsOffTheEdge(page);
  // A bubble may be narrower than the thread, never wider than the window.
  const bubbles = sem(page, "chat-transcript").locator(
    '[flt-semantics-identifier^="message-"]',
  );
  for (let index = 0; index < (await bubbles.count()); index += 1) {
    const box = await bubbles.nth(index).boundingBox();
    if (!box) continue;
    expect(box.x, "a bubble starts left of the window").toBeGreaterThanOrEqual(
      -1,
    );
    expect(
      box.x + box.width,
      "a bubble runs past the right edge",
    ).toBeLessThanOrEqual(PHONE.width + 1);
  }

  /*
   * The Bot's page, from its name, in one tap.
   *
   * This is the finding that made the phone unusable rather than cramped: the
   * gear lived in the right panel's header, the right panel is a closed drawer
   * at this width, and so Name, Label, Description, Routines, the audit log
   * and template import had no route at all on a phone. In this client the
   * Bot's name in the bar opens one page with all of it — its settings, then
   * a row for its Routines and each of its Package pages — one tap from the
   * conversation, with nothing else open.
   */
  await sem(page, "bot-panel-toggle").click();
  await expect(sem(page, "bot-settings")).toBeVisible();
  await expect(sem(page, "routines-panel-toggle")).toBeVisible();
  await expect(sem(page, "bot-settings-save")).toHaveCount(0);
  await shot(page, "04-bot-page");
  await expectNothingRunsOffTheEdge(page);
  await expectWithinViewport(page, "bot-name");

  // A Bot's Plugins are Bot settings, so a phone finds them here rather than
  // under the Profile: the row opens the Bot's own Plugins page.
  await expect(sem(page, "plugins-panel-toggle")).toBeVisible();
  await sem(page, "plugins-panel-toggle").click();
  await expect(sem(page, "plugins-document")).toBeVisible();
  // The page arrives with a transition; the shot is of where it lands.
  await page.waitForTimeout(700);
  await shot(page, "04b-bot-plugins");
  await expectNothingRunsOffTheEdge(page);
  await page.goBack();
  await expect(sem(page, "bot-settings")).toBeVisible();

  // And the way back gives the conversation the whole window again.
  await page.goBack();
  await expect(sem(page, "shell-conversation")).toBeVisible();
  await expect(sem(page, "bot-settings")).toHaveCount(0);

  /*
   * A closed surface leaves nothing over the window.
   *
   * A surface that outlives its own dismissal is invisible and total: every
   * later tap lands on it instead of on what the person aimed at, and the only
   * symptom is a test — or a User — waiting on a control that is plainly
   * there. Opening a surface, closing it, and then using the Bot list is the
   * cheapest proof that the layer went away.
   */
  await openBots(page);
  await sem(page, "sidebar-search").click();
  await expect(sem(page, "search-overlay")).toBeVisible();
  await shot(page, "05-search-surface");
  await expectNothingRunsOffTheEdge(page);
  await page.goBack();
  await expect(sem(page, "search-overlay")).toHaveCount(0);

  /*
   * And the list answers a choice with the conversation, whole.
   *
   * Pocket is the Bot that was open a moment ago, which is the case that once
   * failed: the old drawer closed on a *change* of Bot, and choosing the only
   * Bot in the list changed nothing, so it stayed over four fifths of the
   * window and its profile trigger took the taps meant for the composer
   * (2026-09-05). A page has no such state to get wrong — but the proof that
   * the tap lands at all, and that nothing survives over the composer, is
   * still worth having.
   */
  await openConversation(page, "Pocket");

  // The composer is where it is, and takes a tap: nothing is over it.
  await composerInput(page).click();
  await expect(composerInput(page)).toBeFocused();
});

test("the sign-in page clears the native system bars", async ({
  page,
  allowedFailures,
}) => {
  // This is a layout test for the public shell, so it opens `/` with no
  // development identity: the client finds no session and paints the door. The
  // 401 that tells it so is the answer this test asked for, not a fault.
  allowedFailures.console.push(/Failed to load resource.*401/);
  await page.goto("/");
  const door = sem(page, "sign-in");
  await expect(door).toBeVisible({ timeout: 120_000 });

  await shot(page, "06-sign-in");
  await expectNothingRunsOffTheEdge(page);
  await expectWithinViewport(page, "sign-in");

  // The door's own action is inset from both sides rather than butted against
  // the window, which is what "clears the bars" comes down to in a client that
  // takes its insets from the platform rather than from CSS: the browser
  // reports none, so the page's own padding is the whole of the inset and it
  // is the part this can honestly measure.
  const submit = await sem(page, "sign-in-submit").boundingBox();
  expect(submit, "the sign-in action has no box").not.toBeNull();
  if (!submit) return;
  expect(submit.x, "the action touches the left edge").toBeGreaterThanOrEqual(
    24,
  );
  expect(
    PHONE.width - (submit.x + submit.width),
    "the action touches the right edge",
  ).toBeGreaterThanOrEqual(24);
});
