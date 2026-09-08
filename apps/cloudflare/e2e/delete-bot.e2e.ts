// Deleting a Bot, from its own settings and from Manage Bots.
//
// The unit tests cover the store and the saga; what only the real app can show
// is that the confirmation says what it must before anything is destroyed,
// that the Bot leaves the sidebar without a reload, and that the reload agrees
// — a Bot that came back would mean the directory read, not the view, was
// wrong.
import type { Locator, Page } from "@playwright/test";
import {
  createBot,
  expect,
  openApplication,
  revealSidebar,
  sem,
  SHELL_TIMEOUT_MS,
  test,
} from "./fixtures.ts";

/**
 * Press a named widget.
 *
 * A `Semantics(identifier:)` around a widget that lays itself out — an
 * `ExpansionTile`, a `Card`'s `ListTile` — reaches the accessibility tree as a
 * container with `pointer-events: none`, and the node that takes the tap is
 * its child. Clicking the identifier itself would land on the canvas behind
 * it, so this presses whichever of the two the engine made tappable.
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
 * Something a person can press, by the words on it.
 *
 * Manage Bots is the one surface here with no identifiers of its own: what it
 * offers is prose, and the prose is the claim. A dialog is drawn over the page
 * it belongs to, so where both carry the same verb the dialog's is the later
 * of the two.
 */
function pressable(page: Page, text: string | RegExp) {
  return page.locator("[flt-tappable]").filter({ hasText: text });
}

/** One Bot's row in the sidebar, by the name a person reads on it. */
function sidebarRow(page: Page, name: string) {
  return page
    .locator('[flt-semantics-identifier^="sidebar-bot-"]')
    .filter({ hasText: name });
}

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
  // The state channel is the same race over a socket: an upgrade already
  // on the wire when the delete lands is answered 404, and the browser
  // reports a failed handshake rather than a failed resource.
  allowedFailures.console.push(
    /WebSocket connection to .*state-channel.*(404|410)/u,
  );
  await openApplication(page, userId);

  await createBot(page, "Alpha");
  await createBot(page, "Beta");
  await expect(sidebarRow(page, "Beta")).toHaveCount(1);

  // Beta is the Bot just created, so it is the one selected and the one the
  // right panel is about. Lifecycle lives under Advanced.
  await expect(sem(page, "bot-settings")).toBeVisible({
    timeout: SHELL_TIMEOUT_MS,
  });
  await settle(page);
  await tap(page, "bot-advanced").click();
  await settle(page);
  await tap(page, "flock-delete-bot").click();

  // The confirmation names the Bot and says exactly what will happen. The copy
  // is the promise the User is being asked to accept, so it is asserted rather
  // than approximated.
  const dialog = sem(page, "flock-lifecycle-confirm");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Delete Beta?");
  await expect(dialog).toContainText(
    "This removes its conversation and Applets, and cannot be undone",
  );
  await settle(page);

  // Cancelling destroys nothing.
  await pressable(page, "Cancel").last().click();
  await expect(dialog).toHaveCount(0);
  await expect(sidebarRow(page, "Beta")).toHaveCount(1);

  await settle(page);
  await tap(page, "flock-delete-bot").click();
  await expect(dialog).toBeVisible();
  await settle(page);
  await dialog
    .locator("[flt-tappable]")
    .filter({ hasText: /^Delete$/u })
    .first()
    .click();

  // Gone from the sidebar without a reload, and the surviving Bot is still
  // there.
  await expect(sidebarRow(page, "Beta")).toHaveCount(0, { timeout: 60_000 });
  await expect(sidebarRow(page, "Alpha")).toHaveCount(1);

  // And gone after a reload, because the registration was removed rather than
  // hidden.
  await page.reload();
  await expect(
    sem(page, "shell-sidebar").or(sem(page, "sidebar-toggle")),
  ).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  await revealSidebar(page);
  await expect(sidebarRow(page, "Alpha")).toHaveCount(1, { timeout: 60_000 });
  await expect(sidebarRow(page, "Beta")).toHaveCount(0);
});

test("manage mode offers Archive and Delete, and Delete confirms first", async ({
  page,
  userId,
  allowedFailures,
}) => {
  // Same reason as above: a poll already on the wire when the delete lands is
  // answered 410 or 404, and neither is a fault in the client.
  allowedFailures.console.push(/Failed to load resource.*(404|410)/u);
  // The state channel is the same race over a socket: an upgrade already
  // on the wire when the delete lands is answered 404, and the browser
  // reports a failed handshake rather than a failed resource.
  allowedFailures.console.push(
    /WebSocket connection to .*state-channel.*(404|410)/u,
  );
  await openApplication(page, userId);

  await createBot(page, "Keeper");
  await createBot(page, "Doomed");
  await expect(sidebarRow(page, "Doomed")).toHaveCount(1);

  // Off Manage Bots, a row is a row: nothing destructive is one click away.
  await expect(sem(page, "shell-sidebar").getByText("Delete")).toHaveCount(0);

  await revealSidebar(page);
  await settle(page);
  await tap(page, "sidebar-manage").click();
  const manage = page.getByText("Your Bots, in your control");
  await expect(manage).toBeVisible({ timeout: 60_000 });
  await settle(page);

  // Every Bot offers the same two changes, and each says what it does before
  // it does it.
  for (const name of ["Keeper", "Doomed"]) {
    await pressable(page, name).first().click();
    await expect(pressable(page, "Archive Bot").first()).toBeVisible({
      timeout: 60_000,
    });
    await expect(pressable(page, "Delete Bot").first()).toBeVisible();
    await page.goBack();
    await expect(manage).toBeVisible();
    await settle(page);
  }

  // Delete is irreversible, so it asks — naming the Bot and saying what goes.
  await pressable(page, "Doomed").first().click();
  await expect(pressable(page, "Delete Bot").first()).toBeVisible({
    timeout: 60_000,
  });
  await settle(page);
  await pressable(page, "Delete Bot").first().click();
  await expect(page.getByText("Delete Doomed?")).toBeVisible();
  await expect(
    page.getByText("This removes its conversation and Applets."),
  ).toBeVisible();
  await settle(page);

  // Cancelling destroys nothing.
  await pressable(page, "Cancel").last().click();
  await expect(page.getByText("Delete Doomed?")).toHaveCount(0);
  await settle(page);

  await pressable(page, "Delete Bot").first().click();
  await expect(page.getByText("Delete Doomed?")).toBeVisible();
  await settle(page);
  await pressable(page, "Delete Bot").last().click();
  await expect(manage).toBeVisible({ timeout: 60_000 });
  await expect(pressable(page, "Doomed")).toHaveCount(0, { timeout: 60_000 });
  await expect(pressable(page, "Keeper").first()).toBeVisible();
  await settle(page);

  /*
   * Archiving asks in the same voice as deleting: it names the Bot, and it
   * says what it does in the words a person would use. "History and settings
   * are preserved for restoration" described a mechanism; "You can restore it
   * later" answers the question the dialog is asked (2026-09-05).
   */
  await pressable(page, "Keeper").first().click();
  await expect(pressable(page, "Archive Bot").first()).toBeVisible({
    timeout: 60_000,
  });
  await settle(page);
  await pressable(page, "Archive Bot").first().click();
  await expect(page.getByText("Archive Keeper?")).toBeVisible();
  await expect(page.getByText(/you can restore it later\./u)).toBeVisible();
  await settle(page);
  await pressable(page, "Archive Bot").last().click();

  // And the Bot that comes back says what it is. Before this, an archived Bot
  // looked exactly like a working one and only the word on its action — the
  // difference between "Archive" and "Restore" — said otherwise.
  await expect(pressable(page, "Restore Bot").first()).toBeVisible({
    timeout: 60_000,
  });
  await page.goBack();
  await expect(manage).toBeVisible();
  await expect(page.getByText("Archived · history preserved")).toBeVisible();
});
