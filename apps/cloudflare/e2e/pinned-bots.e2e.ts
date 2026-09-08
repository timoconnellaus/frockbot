// Pinning a Bot moves its sidebar row to a tile above the list. The unit
// tests cover the split and the ordering; what only the real app can show is
// that the durable field written by the settings panel is the one the sidebar
// reads back, and that the Bot leaves the list rather than appearing twice.
import { createBot, expect, openApplication, sem, test } from "./fixtures.ts";
import type { Locator, Page } from "@playwright/test";

/** Every pinned tile above the list. */
function tiles(page: Page): Locator {
  return sem(page, "shell-sidebar").locator(
    '[flt-semantics-identifier^="sidebar-pinned-"]',
  );
}

/** The row for one Bot, found by the name it shows. */
function row(page: Page, name: string): Locator {
  return sem(page, "shell-sidebar")
    .locator('[flt-semantics-identifier^="sidebar-bot-"]')
    .filter({ hasText: name });
}

// Tall enough that the Bot panel's own Save is on screen. The panel is a
// column of fields ending in Save, and at the default height that button is
// below the fold — a canvas has nothing for Playwright to scroll into view.
test.use({ viewport: { width: 1280, height: 1024 } });

test("pinning a Bot from its settings moves it to a tile above the list", async ({
  page,
  userId,
}) => {
  // Saving the panel also saves the notification policy, which is on by
  // default and asks the browser for permission; grant it so the save runs to
  // the end rather than stopping on a refusal this test is not about.
  await page.context().grantPermissions(["notifications"]);
  await openApplication(page, userId);

  await createBot(page, "Alpha");
  await createBot(page, "Beta");

  await expect(tiles(page)).toHaveCount(0);
  await expect(row(page, "Beta")).toHaveCount(1);

  // Beta is the Bot just created, so its panel is the one already open. The
  // switch is the tappable node inside the named row, and its own
  // `aria-checked` is how the engine says which way it is set.
  const pinned = sem(page, "bot-pinned").locator('[role="switch"]');
  await expect(pinned).toHaveAttribute("aria-checked", "false");
  await pinned.click();
  await expect(pinned).toHaveAttribute("aria-checked", "true");
  await sem(page, "bot-settings-save").click();

  const tile = tiles(page);
  await expect(tile).toHaveCount(1);
  await expect(tile).toContainText("Beta");
  // A pinned Bot is the tile instead of the row, never both.
  await expect(row(page, "Beta")).toHaveCount(0);
  await expect(row(page, "Alpha")).toHaveCount(1);

  // And it survives a reload, because the pin is durable rather than a view.
  await page.reload();
  await expect(tiles(page)).toHaveCount(1);

  // The tile opens the Bot exactly as its row would. The Flutter client keeps
  // the selection in its own store rather than in the address, so which Bot is
  // open is read off the list: the open row is the current one.
  await row(page, "Alpha").click();
  await expect(row(page, "Alpha")).toHaveAttribute("aria-current", "true");
  await tiles(page).click();
  await expect(row(page, "Alpha")).toHaveAttribute("aria-current", "false");
});
