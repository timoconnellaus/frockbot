// Pinning a Bot moves its sidebar row to a tile above the list. The unit
// tests cover the split and the ordering; what only the real app can show is
// that the durable field written by the settings panel is the one the sidebar
// reads back, and that the Bot leaves the list rather than appearing twice.
import {
  createBot,
  expect,
  firstRunDialog,
  openApplication,
  test,
} from "./fixtures.ts";

test("pinning a Bot from its settings moves it to a tile above the list", async ({
  page,
  userId,
}) => {
  // Saving the panel also saves the notification policy, which is on by
  // default and asks the browser for permission; grant it so the save runs to
  // the end rather than stopping on a refusal this test is not about.
  await page.context().grantPermissions(["notifications"]);
  await openApplication(page, userId);
  await firstRunDialog(page).getByRole("button", { name: "Cancel" }).click();

  await createBot(page, "Alpha");
  await createBot(page, "Beta");

  const sidebar = page.locator("aside.sidebar");
  await expect(sidebar.locator(".flock-pinned-tile")).toHaveCount(0);
  await expect(
    sidebar.locator(".flock-bot-row").filter({ hasText: "Beta" }),
  ).toHaveCount(1);

  await page.getByRole("button", { name: "Bot settings" }).click();
  const panel = page.getByRole("region", { name: "Settings" });
  await expect(panel).toBeVisible();
  await panel.locator("#bot-pinned").getByRole("checkbox").check();
  await panel.getByRole("button", { name: "Save settings" }).click();

  const tile = sidebar.locator(".flock-pinned-tile");
  await expect(tile).toHaveCount(1);
  await expect(tile).toHaveText(/Beta/u);
  // A pinned Bot is the tile instead of the row, never both.
  await expect(
    sidebar.locator(".flock-bot-row").filter({ hasText: "Beta" }),
  ).toHaveCount(0);
  await expect(
    sidebar.locator(".flock-bot-row").filter({ hasText: "Alpha" }),
  ).toHaveCount(1);

  // And it survives a reload, because the pin is durable rather than a view.
  await page.reload();
  await expect(sidebar.locator(".flock-pinned-tile")).toHaveCount(1);

  // The tile opens the Bot exactly as its row would.
  await sidebar.locator(".flock-bot-row").filter({ hasText: "Alpha" }).click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("bot"))
    .not.toBeNull();
  const alpha = new URL(page.url()).searchParams.get("bot");
  await sidebar.locator(".flock-pinned-tile").click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("bot"))
    .not.toBe(alpha);
});
