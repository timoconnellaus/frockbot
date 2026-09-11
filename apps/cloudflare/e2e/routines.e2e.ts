// The Routines panel, through the browser: the two places it used to fail a
// person quietly.
//
// Both were found by dogfooding, and neither could be seen from a unit test.
// The write path already refused a bad schedule correctly and the delete
// command already worked — what was missing was the browser telling anyone.
// A refusal was invisible, so the form simply appeared to do nothing; and
// Delete went straight through from a single click, in a row of six other
// buttons, taking the schedule, the prompt and the whole run log with it.
//
// Routines is a server-projected document, so every control here is named by
// the projection's own ids — `view-field-routine.*`, `view-action-*` and the
// group a Routine's name slugs to — and only the confirmation is host chrome
// with a name of its own.
import {
  test,
  expect,
  action,
  createBot,
  answerFields,
  documentField,
  group,
  openApplication,
  press,
  sem,
} from "./fixtures.ts";
import type { Locator, Page } from "@playwright/test";

/**
 * The browser runs in a real zone that is not UTC, which is what makes "the
 * moment is read in the Routine's own zone" a claim this spec can test: a
 * schedule read in Sydney and the same schedule read in UTC are different
 * times of day, and the panel must show the Routine's.
 */
test.use({ timezoneId: "Australia/Sydney" });

/**
 * Answer the editor's fields, and leave them answered.
 *
 * `answerFields` types through the editing session rather than filling: a
 * `fill` writes the element's value and not the widget's, so the document's
 * required key could refuse a form this side had read back as answered. The
 * click that helper once made is gone with it — inside the right panel the
 * document's semantics nodes overlap and the node above the field took the
 * pointer — and `focus()` names the element with no geometry at all.
 */
async function answer(
  page: Page,
  values: Record<string, string>,
): Promise<void> {
  await answerFields(page, values);
}

/**
 * Open the Routines surface through the Routines control in the chat header —
 * the one door to a Routine firing on the wide tiers, so it is the door this
 * spec uses.
 */
async function openRoutines(page: Page): Promise<Locator> {
  await press(sem(page, "routines-panel-toggle"));
  const document = sem(page, "routines-document");
  await expect(document).toBeVisible({ timeout: 60_000 });
  return document;
}

/**
 * The one editor, expanded. There is a single form on the surface — a new
 * Routine, or the one the reader asked to edit — and it ships collapsed so a
 * surface someone came to read is not mostly a form.
 */
async function openEditor(page: Page): Promise<void> {
  await group(page, "New Routine").click();
  await expect(documentField(page, "routine.name")).toBeVisible();
}

test("a refused schedule is said out loud, and the form keeps what to correct", async ({
  page,
  userId,
  allowedFailures,
}) => {
  // The refusal is a real 400 from the write path; the spec is about what the
  // browser does with it.
  allowedFailures.requests.push(/\/api\/bots\/[^/]+\/routines$/u);
  allowedFailures.console.push(/Failed to load resource.*400/u);

  await openApplication(page, userId);
  await createBot(page, "Scheduler");
  const document = await openRoutines(page);
  await openEditor(page);

  await answer(page, {
    "routine.name": "Blursday brief",
    "routine.prompt": "Summarise overnight email.",
    "routine.schedule": "every Blursday",
  });
  await press(action(page, "save-routine"));

  // The refusal is on the surface, in the host's own words. The reason the
  // route gave is not among them — the client does not carry a refusal's text
  // — so what this proves is that the press was answered rather than swallowed.
  await expect(
    document.getByText(
      "That action couldn’t be completed. Refresh and try again.",
    ),
  ).toBeVisible();

  // Nothing was stored, and the form is still open with the value to correct.
  await expect(group(page, "Blursday brief")).toHaveCount(0);
  await expect(document).toHaveAttribute("aria-label", /No Routines yet/u);
  // Focused before it is read. Flutter mirrors a field's text into the DOM
  // input only while it is holding an editing session open on it, and it puts
  // the text nowhere in the semantics tree at all — so a settled field reads
  // back empty from the browser whatever it is showing a person. Focusing is
  // what opens the session, and costs nothing: the reader's next act on a form
  // they are being asked to correct is to put the caret in it.
  const schedule = documentField(page, "routine.schedule");
  await schedule.focus();
  await expect(schedule).toHaveValue("every Blursday");

  // Correcting it saves, and the Routine is on the surface.
  await answer(page, { "routine.schedule": "0 9 * * *" });
  await press(action(page, "save-routine"));
  const card = group(page, "Blursday brief");
  await expect(card).toBeVisible({ timeout: 60_000 });

  // The moment reads as a moment, not as the wire: the house order, in the
  // Routine's own zone rather than the browser's — 9:00am in UTC is 7:00pm in
  // Sydney, and this spec's browser is in Sydney.
  await expect(card).toHaveAttribute(
    "aria-label",
    /Next \d{1,2} [A-Z][a-z]{2} \d{4}, 9:00am/u,
  );
  await expect(card).not.toHaveAttribute("aria-label", /\d{2}:\d{2}:\d{2}/u);
});

test("deleting a Routine asks first, and Cancel keeps it", async ({
  page,
  userId,
}) => {
  await openApplication(page, userId);
  await createBot(page, "Keeper");
  const document = await openRoutines(page);
  await openEditor(page);

  await answer(page, {
    "routine.name": "Morning brief",
    "routine.prompt": "Summarise overnight email.",
    "routine.schedule": "0 9 * * *",
  });
  await press(action(page, "save-routine"));
  const card = group(page, "Morning brief");
  await expect(card).toBeVisible({ timeout: 60_000 });

  // One click used to be the whole of it. Now it asks, and says what goes.
  await press(action(card, "delete-routine"));
  const confirm = sem(page, "routine-delete-confirm");
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText("run log");

  // Cancelling keeps it, and leaves the panel exactly as it was. That the
  // Routine survived the asking is checked here rather than while the
  // confirmation is up: a modal takes the surface behind it out of the
  // accessibility tree, so there is nothing to count until it closes.
  await confirm.getByText("Cancel").click();
  await expect(confirm).toHaveCount(0);
  await expect(card).toBeVisible();

  // Confirming is what deletes it.
  await press(action(card, "delete-routine"));
  await confirm.getByText("Delete Routine").click();
  await expect(card).toHaveCount(0, { timeout: 60_000 });
  await expect(document).toHaveAttribute("aria-label", /No Routines yet/u);
});
