// Deleting a Bot, from its own settings and from an archived Bot's bar.
//
// The unit tests cover the store and the saga; what only the real app can show
// is that the confirmation says what it must before anything is destroyed,
// that the Bot leaves the sidebar without a reload, and that the reload agrees
// — a Bot that came back would mean the directory read, not the view, was
// wrong.
import type { Locator, Page, Request } from "@playwright/test";
import {
  createBot,
  expect,
  openApplication,
  revealSidebar,
  sem,
  SHELL_TIMEOUT_MS,
  settle,
  tap,
  test,
  openBotSettings,
  press,
} from "./fixtures.ts";

/**
 * Something a person can press, by the words on it. A dialog is drawn over
 * the page it belongs to, so where both carry the same verb the dialog's is
 * the later of the two.
 */
function pressable(page: Page, text: string | RegExp) {
  return page.locator("[flt-tappable]").filter({ hasText: text });
}

/** The deletion the client sends once the confirmation is accepted. */
function deletionSent(page: Page) {
  return page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      /\/api\/bots\/[^/]+\/lifecycle$/u.test(new URL(request.url()).pathname) &&
      (request.postDataJSON() as { type?: string } | null)?.type ===
        "bot/delete",
    { timeout: 60_000 },
  );
}

/** The deletion request the confirmation triggered, once it completes. */
async function expectDeletionApplied(
  _page: Page,
  sent: Promise<Request>,
): Promise<void> {
  const request = await sent;
  const response = await request.response();
  expect(response?.status()).toBe(200);
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
  // right panel is about. Lifecycle is the last card in its Settings.
  await openBotSettings(page);
  await settle(page);
  await tap(page, "flock-delete-bot").click();

  // The confirmation names the Bot and says exactly what will happen. The copy
  // is the promise the User is being asked to accept, so it is asserted rather
  // than approximated.
  const dialog = sem(page, "flock-lifecycle-confirm");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Delete Beta?");
  await expect(dialog).toContainText(
    "This removes its conversation and cannot be undone",
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
  const sent = deletionSent(page);
  await dialog
    .locator("[flt-tappable]")
    .filter({ hasText: /^Delete$/u })
    .first()
    .click();

  // Gone from the sidebar without a reload, and the surviving Bot is still
  // there.
  await expect(sidebarRow(page, "Beta")).toHaveCount(0, { timeout: 60_000 });
  await expectDeletionApplied(page, sent);
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

test("an archived Bot opens read-only from the sidebar, and its bar deletes it after asking", async ({
  page,
  userId,
  allowedFailures,
}) => {
  // Same reason as above: a poll already on the wire when the delete lands is
  // answered 410 or 404, and neither is a fault in the client.
  allowedFailures.console.push(/Failed to load resource.*(404|410)/u);
  allowedFailures.console.push(
    /WebSocket connection to .*state-channel.*(404|410)/u,
  );
  await openApplication(page, userId);

  await createBot(page, "Keeper");
  await createBot(page, "Doomed");
  await expect(sidebarRow(page, "Doomed")).toHaveCount(1);

  // A row is a row: nothing destructive is one click away in the list.
  await expect(sem(page, "shell-sidebar").getByText("Delete")).toHaveCount(0);

  /*
   * Archiving asks in the same voice as deleting: it names the Bot, and it
   * says what it does in the words a person would use (2026-09-05).
   */
  await openBotSettings(page);
  await settle(page);
  await tap(page, "flock-archive-bot").click();
  const dialog = sem(page, "flock-lifecycle-confirm");
  await expect(dialog).toContainText("Archive Doomed?");
  await expect(dialog).toContainText(/you can restore it later\./u);
  await settle(page);
  await pressable(page, "Archive Bot").last().click();

  // The archived Bot leaves the list for its own folded group at the foot.
  await expect(sidebarRow(page, "Doomed")).toHaveCount(0, { timeout: 60_000 });
  await revealSidebar(page);
  await expect(sem(page, "sidebar-archived-toggle")).toContainText(
    "Archived · 1",
    { timeout: 60_000 },
  );
  await tap(page, "sidebar-archived-toggle").click();
  await expect(sidebarRow(page, "Doomed")).toHaveCount(1);

  // It opens read-only: its conversation, and a bar where the composer was.
  await press(sidebarRow(page, "Doomed"));
  const bar = sem(page, "flock-archived-bar");
  // The bar's sentence is its accessible name; its buttons are its text.
  await expect(bar).toHaveAttribute(
    "aria-label",
    "Doomed is archived. Its conversation is kept, but it won’t reply or run its Routines.",
    { timeout: 60_000 },
  );
  await expect(sem(page, "chat-composer")).toHaveCount(0);
  await settle(page);

  // Delete is irreversible, so it asks — naming the Bot and saying what goes.
  await tap(page, "flock-archived-delete").click();
  await expect(dialog).toContainText("Delete Doomed?");
  await expect(dialog).toContainText(
    "This removes its conversation and cannot be undone",
  );
  await settle(page);

  // Cancelling destroys nothing.
  await pressable(page, "Cancel").last().click();
  await expect(dialog).toHaveCount(0);
  await expect(bar).toBeVisible();
  await settle(page);

  await tap(page, "flock-archived-delete").click();
  await expect(dialog).toBeVisible();
  await settle(page);
  const sent = deletionSent(page);
  await dialog
    .locator("[flt-tappable]")
    .filter({ hasText: /^Delete$/u })
    .first()
    .click();
  await expectDeletionApplied(page, sent);
  await expect(bar).toHaveCount(0, { timeout: 60_000 });
  await revealSidebar(page);
  await expect(sem(page, "sidebar-archived-toggle")).toHaveCount(0, {
    timeout: 60_000,
  });
  await expect(sidebarRow(page, "Doomed")).toHaveCount(0);
  await expect(sidebarRow(page, "Keeper")).toHaveCount(1);
});
