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
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("#ui-confirm-title")).toHaveText("Delete Beta?");
  await expect(
    dialog.getByText(
      "This removes its conversation and Applets, and cannot be undone",
    ),
  ).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeVisible();

  // Cancelling destroys nothing.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(beta).toHaveCount(1);

  await panel.getByRole("button", { name: "Delete Bot" }).click();
  await page
    .getByRole("alertdialog")
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

test("manage mode offers Archive and Delete, and Delete confirms first", async ({
  page,
  userId,
  allowedFailures,
}) => {
  // Same reason as above: a poll already on the wire when the delete lands is
  // answered 410 or 404, and neither is a fault in the client.
  allowedFailures.console.push(/Failed to load resource.*(404|410)/u);
  await openApplication(page, userId);
  await firstRunDialog(page).getByRole("button", { name: "Cancel" }).click();

  await createBot(page, "Keeper");
  await createBot(page, "Doomed");

  const sidebar = page.locator("aside.sidebar");
  const doomed = sidebar
    .locator(".flock-bot-row")
    .filter({ hasText: "Doomed" });
  await expect(doomed).toHaveCount(1);

  // Off the mode, a row is a row: nothing destructive is one click away.
  await expect(doomed.getByRole("button", { name: "Delete" })).toHaveCount(0);

  // Manage and Done are the same toggle, so they are the same control in its
  // two states rather than a link that becomes a button.
  const manage = sidebar.getByRole("button", { name: "Manage" });
  await expect(manage).toHaveAttribute("aria-pressed", "false");
  await manage.click();
  const done = sidebar.getByRole("button", { name: "Done" });
  await expect(done).toHaveAttribute("aria-pressed", "true");

  // Every row offers the same two actions, in one aligned group, and the two
  // groups line up with each other: a Bot's actions are where the last Bot's
  // were, whichever row the pointer is over.
  const keeper = sidebar
    .locator(".flock-bot-row")
    .filter({ hasText: "Keeper" });
  for (const row of [keeper, doomed]) {
    await expect(row.getByRole("button", { name: "Archive" })).toBeVisible();
    await expect(row.getByRole("button", { name: "Delete" })).toBeVisible();
  }
  const keeperActions = await keeper
    .locator(".flock-row-actions")
    .boundingBox();
  const doomedActions = await doomed
    .locator(".flock-row-actions")
    .boundingBox();
  expect(keeperActions?.x).toBe(doomedActions?.x ?? -1);
  expect(keeperActions?.width).toBe(doomedActions?.width ?? -1);

  // Delete is irreversible, so it asks — naming the Bot and saying what goes.
  await doomed.getByRole("button", { name: "Delete" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog.locator("#ui-confirm-title")).toHaveText(
    "Delete Doomed?",
  );
  await expect(
    dialog.getByText("This removes its conversation and Applets"),
  ).toBeVisible();

  // Cancelling destroys nothing.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(doomed).toHaveCount(1);

  await doomed.getByRole("button", { name: "Delete" }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(doomed).toHaveCount(0);
  await expect(keeper).toHaveCount(1);

  /*
   * Archiving asks in the same voice as deleting: it names the Bot, and it
   * says what it does in the words a person would use. "History and settings
   * are preserved for restoration" described a mechanism; "You can restore it
   * later" answers the question the dialog is asked (2026-09-05).
   */
  await keeper.getByRole("button", { name: "Archive" }).click();
  const archiveDialog = page.getByRole("alertdialog");
  await expect(archiveDialog.locator("#ui-confirm-title")).toHaveText(
    "Archive Keeper?",
  );
  await expect(
    archiveDialog.getByText("You can restore it later."),
  ).toBeVisible();
  await archiveDialog.getByRole("button", { name: "Archive Bot" }).click();

  // And the row that comes back says what it is. Before this, an archived Bot
  // looked exactly like a working one and only the word on its action — the
  // difference between "Archive" and "Restore" — said otherwise.
  await expect(archiveDialog).toBeHidden();
  await expect(keeper).toHaveClass(/archived/u);
  await expect(keeper.getByText("Archived")).toBeVisible();
  await expect(keeper.getByRole("button", { name: "Restore" })).toBeVisible();
});
