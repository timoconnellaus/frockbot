// The phone layout.
//
// The hosted WebUI is the product UI on every platform (`AGENTS.md`, "One
// production path"), so the phone is not a separate client: it is this same
// Flutter bundle at a 390pt viewport. Below 640 the shell is one column
// (`apps/native/lib/shell/desktop_layout.dart`), which means the Bot list and
// the right panel are both reachable only as drawers or as pages — and this
// spec measures what that costs rather than eyeballing it.
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
 */
async function expectNothingRunsOffTheEdge(page: Page): Promise<void> {
  const offending = await page.evaluate((width) => {
    const wide: { id: string; left: number; right: number }[] = [];
    for (const node of document.querySelectorAll(
      "[flt-semantics-identifier]",
    )) {
      const box = node.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      if (box.left < -1 || box.right > width + 1) {
        wide.push({
          id: node.getAttribute("flt-semantics-identifier") ?? "?",
          left: Math.round(box.left),
          right: Math.round(box.right),
        });
      }
    }
    return wide;
  }, PHONE.width);
  expect(offending, "these widgets run off the side of the window").toEqual([]);
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

/** Open the navigation drawer and prove it arrived. */
async function openNavigation(page: Page): Promise<void> {
  await sem(page, "sidebar-toggle").click();
  await expect(sem(page, "shell-sidebar")).toBeVisible();
}

/**
 * Close it by tapping the conversation behind it, which is the way back a
 * person reaches for before they look for a control.
 *
 * The tap is offset deliberately. The scrim covers the window, so its centre
 * is behind the drawer; what a person actually taps is the strip of
 * conversation still showing beside it, and that is the gesture worth proving.
 */
async function closeNavigation(page: Page): Promise<void> {
  // A raw tap rather than a click on a named widget: what receives it is the
  // shell's own dismiss gesture, and which widget that belongs to is the
  // layout's business rather than this spec's.
  await page.mouse.click(PHONE.width - 20, PHONE.height / 2);
  await expect(sem(page, "shell-sidebar")).toBeHidden();
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

  // One column: the Bot list is behind the toggle rather than beside the
  // conversation, and the conversation has the window.
  await expect(sem(page, "sidebar-toggle")).toBeVisible();
  await expect(sem(page, "shell-sidebar")).toBeHidden();
  await expect(composerInput(page)).toBeVisible();
  await shot(page, "01-empty-thread");
  await expectNothingRunsOffTheEdge(page);
  await expectWithinViewport(page, "chat-composer");
  await expectWithinViewport(page, "send-button");

  // The Bot list and the sidebar's own actions live behind the drawer on a
  // phone, so reaching any of them is itself a test of the drawer.
  await openNavigation(page);
  await shot(page, "02-navigation-drawer");
  await expectNothingRunsOffTheEdge(page);
  await expectWithinViewport(page, "shell-sidebar");
  await closeNavigation(page);

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
   * Bot settings, from the conversation, in one tap.
   *
   * This is the finding that made the phone unusable rather than cramped: the
   * gear lived in the right panel's header, the right panel is a closed drawer
   * at this width, and so Name, Label, Description, Routines, the audit log
   * and template import had no route at all on a phone. In this client the
   * panel's entries are pages instead of a drawer, and the toggle in the
   * header is how they are reached — one tap from the conversation, with
   * nothing else open.
   */
  await sem(page, "bot-panel-toggle").click();
  // With more than one entry the toggle offers them first, which is the
  // selector the wide layout draws as a segmented control.
  const chooser = page.getByText("Settings", { exact: true });
  if (await chooser.isVisible().catch(() => false)) await chooser.click();
  await expect(sem(page, "bot-settings")).toBeVisible();
  await shot(page, "04-bot-settings-page");
  await expectNothingRunsOffTheEdge(page);
  await expectWithinViewport(page, "bot-name");

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
  await openNavigation(page);
  await sem(page, "sidebar-search").click();
  await expect(sem(page, "search-overlay")).toBeVisible();
  await shot(page, "05-search-surface");
  await expectNothingRunsOffTheEdge(page);
  await page.goBack();
  await expect(sem(page, "search-overlay")).toHaveCount(0);

  /*
   * And the drawer closes behind a choice.
   *
   * Pocket is the Bot already open, which is the case that failed: the drawer
   * closed on a *change* of Bot, and choosing the only Bot in the list changes
   * nothing. So the drawer stayed over four fifths of the window, its profile
   * trigger took the taps meant for the composer, and the strip of
   * conversation beside it was the only way out (2026-09-05).
   *
   * The proof is also that the tap lands at all: a surviving scrim swallows it
   * and the row simply never answers.
   */
  await openNavigation(page);
  await sem(page, "shell-sidebar")
    .locator('[flt-semantics-identifier^="sidebar-bot-"]')
    .filter({ hasText: "Pocket" })
    .click();
  await expect(sem(page, "shell-sidebar")).toBeHidden();

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
