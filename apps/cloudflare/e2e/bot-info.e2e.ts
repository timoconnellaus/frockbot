// The Package-composed right panel (register rows 50 and 51). The page fixture
// also fails on any console or request error, which proves the Contributions
// can mount together rather than only that their individual components compile.
import type { Locator, Page } from "@playwright/test";
import {
  createBot,
  expect,
  openApplication,
  sem,
  SHELL_TIMEOUT_MS,
  test,
} from "./fixtures.ts";

/**
 * Press a named widget.
 *
 * A `Semantics(identifier:)` around a widget that lays itself out reaches the
 * accessibility tree as a container with `pointer-events: none`, and the node
 * that takes the tap is its child. Clicking the identifier itself would land
 * on the canvas behind it, so this presses whichever of the two the engine
 * made tappable.
 */
function tap(scope: Page | Locator, identifier: string) {
  const node = `[flt-semantics-identifier="${identifier}"]`;
  return scope.locator(`${node}[flt-tappable], ${node} [flt-tappable]`).first();
}

/**
 * Let a surface finish arriving before pressing anything on it.
 *
 * Flutter rebuilds the accessibility tree when semantics change rather than
 * once a frame, so a sliding sheet or a pushed page reaches the DOM at its
 * final position while the canvas is still moving — and Playwright's own
 * stability check, which watches that DOM box, sees nothing to wait for. The
 * engine hit-tests a press against the frame it is painting, so a press issued
 * then lands on whatever is passing under the pointer.
 */
async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(700);
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
 * One of the chat header's doors into the right panel, by its name.
 *
 * The header's icons are the only way of choosing what the panel holds; the
 * panel itself names its entry and offers the way out, nothing more. An icon
 * button's name is its tooltip, and the header's is the first in the document.
 */
function door(page: Page, label: string) {
  return page.getByRole("button", { name: label, exact: true }).first();
}

/**
 * The panel, showing the entry it names.
 *
 * The name is one line of text at the top of the region, but the engine
 * merges a leaf that heads a group into the group's accessible name rather
 * than its text content, so the word is read from the label and not from the
 * text.
 */
function panelNamed(page: Page, label: string) {
  return sem(page, "shell-right-panel")
    .locator(`[aria-label="${label}"]`)
    .first();
}

/**
 * How far the window scrolls sideways.
 *
 * Flutter paints to a canvas sized to the window, so an overflowing layout
 * clips rather than widening the document — but a host element that escaped
 * its bounds still would, which is the failure this has always watched for.
 */
async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
}

test("the default panel composes Computer and Routines and swaps to Settings", async ({
  page,
  userId,
}) => {
  await page.setViewportSize({ width: 1351, height: 859 });
  await openApplication(page, userId);
  await createBot(page, "Observed");
  await settle(page);

  // At this width the region is a column the shell draws, and every feature
  // that filled it is one press away in the chat header. The region names the
  // entry it is showing, and only that one.
  const panel = sem(page, "shell-right-panel");
  await expect(panel).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  // Bot settings is the entry the region opens on.
  await expect(panelNamed(page, "Settings")).toBeVisible();
  await expect(sem(page, "bot-settings")).toBeVisible();

  await settle(page);
  await door(page, "Computer").click();
  await expect(sem(page, "computer-card")).toBeVisible({ timeout: 60_000 });
  await expect(panelNamed(page, "Computer")).toBeVisible();
  // The card is the whole statement: no caption repeats it underneath.
  await expect(says(page, "Observed's screen")).toHaveCount(0);

  await settle(page);
  await door(page, "Routines").click();
  await expect(sem(page, "routines-document")).toBeVisible({ timeout: 60_000 });
  await expect(panelNamed(page, "Routines")).toBeVisible();
  await expect(says(page, "No Routines yet.").first()).toBeVisible();

  await settle(page);
  await tap(page, "bot-panel-toggle").click();
  await expect(sem(page, "bot-settings")).toBeVisible();
  await expect(panelNamed(page, "Settings")).toBeVisible();

  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
});

test("the default panel and Settings fit the mobile shell", async ({
  page,
  userId,
}) => {
  await openApplication(page, userId);
  await createBot(page, "Pocket");
  await settle(page);
  await page.setViewportSize({ width: 390, height: 844 });

  // On a phone the right panel is not a column: its entries are pages, and the
  // toggle beside the conversation title is how one is chosen. A panel that
  // opened itself over the conversation is the layout this replaced, so
  // nothing is on screen until it is asked for.
  await expect(sem(page, "bot-settings")).toHaveCount(0);
  await settle(page);
  // One tap. The header names its three destinations separately now, so the
  // Bot settings control opens Bot settings rather than a chooser of what the
  // region holds.
  await tap(page, "bot-panel-toggle").click();
  await expect(sem(page, "bot-settings")).toBeVisible({ timeout: 60_000 });
  await expect(says(page, "Pocket's screen")).toHaveCount(0);

  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
});
