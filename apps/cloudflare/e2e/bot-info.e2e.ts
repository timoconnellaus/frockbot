// The Package-composed right panel (register rows 50 and 51). The page fixture
// also fails on any console or request error, which proves the Contributions
// can mount together rather than only that their individual components compile.
import type { Locator, Page } from "@playwright/test";
import {
  createBot,
  expect,
  expectNoHorizontalOverflow,
  openApplication,
  openBotPage,
  press,
  sem,
  SHELL_TIMEOUT_MS,
  settle,
  test,
} from "./fixtures.ts";

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
 * The Computer destination in the chat header.
 *
 * The bar keeps the Bot's name, the Computer and the panel's own switch; every
 * other door is a row on the Bot page. Its identifier distinguishes this
 * full-window destination from the Computer card on the Bot page.
 */
function computerDestination(page: Page) {
  return sem(page, "computer-destination");
}

test("the panel opens on the Bot page and its rows push onto it", async ({
  page,
  userId,
}) => {
  await page.setViewportSize({ width: 1351, height: 859 });
  await openApplication(page, userId);
  await createBot(page, "Observed");
  await settle(page);

  // At this width the region is a column the shell draws, and the Bot page is
  // its floor: the Bot's name at the top of it, and no way back from there.
  const panel = sem(page, "shell-right-panel");
  await expect(panel).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  await expect(
    says(sem(page, "shell-right-panel"), "Observed").first(),
  ).toBeVisible();
  await expect(sem(page, "bot-page").first()).toBeVisible();
  await expect(sem(page, "right-panel-back")).toHaveCount(0);

  await settle(page);
  await press(computerDestination(page));
  await expect(sem(page, "computer-viewer")).toBeVisible({ timeout: 60_000 });
  // Computer opens a full window; returning restores the Bot page.
  await expect(says(page, "Observed's screen")).toHaveCount(0);

  await settle(page);
  await page.goBack();
  await expect(sem(page, "bot-page").first()).toBeVisible();
  await settle(page);
  await press(sem(page, "bot-page-routines-all"));
  await expect(sem(page, "routines-document")).toBeVisible({ timeout: 60_000 });
  await expect(
    says(sem(page, "shell-right-panel"), "All Routines").first(),
  ).toBeVisible();
  await expect(says(page, "No Routines yet").first()).toBeVisible();

  // The chevron goes back one level; the name in the bar goes all the way.
  await settle(page);
  await press(sem(page, "right-panel-back"));
  await expect(sem(page, "bot-page").first()).toBeVisible();
  await settle(page);
  await press(sem(page, "bot-page-settings").first());
  await expect(sem(page, "bot-settings")).toBeVisible({ timeout: 60_000 });
  await settle(page);
  await openBotPage(page);
  await expect(sem(page, "bot-settings")).toHaveCount(0);

  await expectNoHorizontalOverflow(page, 1);
});

test("the Bot page and Settings fit the mobile shell", async ({
  page,
  userId,
}) => {
  await openApplication(page, userId);
  await createBot(page, "Pocket");
  await settle(page);
  await page.setViewportSize({ width: 390, height: 844 });

  // On a phone the panel is not a column: its entries are pages, and the name
  // pill beside the conversation title is how the first of them is opened.
  await expect(sem(page, "bot-page")).toHaveCount(0);
  await settle(page);
  await openBotPage(page);
  await expect(says(page, "Pocket's screen")).toHaveCount(0);
  await settle(page);
  await press(sem(page, "bot-page-settings").first());
  await expect(sem(page, "bot-settings")).toBeVisible({ timeout: 60_000 });

  await expectNoHorizontalOverflow(page, 1);
});
