// Deleting a Bot from its settings panel.
//
// The unit tests cover the store and the saga; what only the real app can show
// is that the confirmation says what it must before anything is destroyed,
// that the Bot leaves the sidebar without a reload, and that the reload agrees
// — a Bot that came back would mean the directory read, not the view, was
// wrong.
import {
  createBot,
  expect,
  firstRunDialog,
  openApplication,
  test,
} from "./fixtures.ts";

test("deleting a Bot from its settings removes it for good", async ({
  page,
  userId,
  allowedFailures,
}) => {
  // The panels of the Bot being looked at poll it. Deleting that Bot moves the
  // selection off it at once, which aborts the reads still in flight, but a
  // read already on the wire when the delete lands still gets an answer: 410
  // while the Bot's own tombstone is what replies, 404 once the registration
  // has left the User's directory. Both are the right answer to "give me this
  // Bot's transcript" for a Bot that has just been deleted, and the race is
  // one no client can close from its side. What this does *not* allow is a
  // 500, which is what these routes used to return.
  allowedFailures.console.push(/Failed to load resource.*(404|410)/u);
  await openApplication(page, userId);
  await firstRunDialog(page).getByRole("button", { name: "Cancel" }).click();

  await createBot(page, "Alpha");
  await createBot(page, "Beta");

  const sidebar = page.locator("aside.sidebar");
  const beta = sidebar.locator(".flock-bot-row").filter({ hasText: "Beta" });
  await expect(beta).toHaveCount(1);

  await page.getByRole("button", { name: "Bot settings" }).click();
  const panel = page.getByRole("region", { name: "Settings" });
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "Delete Bot" }).click();

  // The confirmation names the Bot and says exactly what will happen. The
  // copy is the promise the User is being asked to accept, so it is asserted
  // rather than approximated.
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("#flock-title")).toHaveText("Delete Beta?");
  await expect(
    dialog.getByText(
      "This Bot and its chat history will be permanently deleted.",
    ),
  ).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeVisible();

  // Cancelling destroys nothing.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(beta).toHaveCount(1);

  await panel.getByRole("button", { name: "Delete Bot" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete", exact: true })
    .click();

  // Gone from the sidebar without a reload, and the surviving Bot is selected.
  await expect(beta).toHaveCount(0);
  await expect(
    sidebar.locator(".flock-bot-row").filter({ hasText: "Alpha" }),
  ).toHaveCount(1);

  // And gone after a reload, because the registration was removed rather than
  // hidden.
  await page.reload();
  await expect(
    sidebar.locator(".flock-bot-row").filter({ hasText: "Beta" }),
  ).toHaveCount(0);
  await expect(
    sidebar.locator(".flock-bot-row").filter({ hasText: "Alpha" }),
  ).toHaveCount(1);
});
