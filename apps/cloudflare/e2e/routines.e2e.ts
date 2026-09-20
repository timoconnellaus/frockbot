// The Routines panel, through the browser: trigger-specific setup, friendly
// schedules, and a destructive action that always asks first.
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
  spokenText,
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
 * Open the Routines surface through the All Routines row on the Bot page —
 * the one door to the list at every tier, so it is the door this spec uses.
 */
async function openRoutines(page: Page): Promise<Locator> {
  await press(sem(page, "bot-page-routines-all").first());
  const document = sem(page, "routines-document");
  await expect(document).toBeVisible({ timeout: 60_000 });
  return document;
}

/**
 * The editor as its own page. The list's New Routine button opens it; a
 * surface someone came to read is not a form.
 */
async function openEditor(page: Page): Promise<void> {
  await press(sem(page, "routine-create"));
  await expect(sem(page, "routine-editor")).toBeVisible();
  await expect(documentField(page, "routine.name")).toBeVisible();
}

test("the trigger choice only shows its own setup, and schedules stay human", async ({
  page,
  userId,
}) => {
  await openApplication(page, userId);
  await createBot(page, "Scheduler");
  const document = await openRoutines(page);
  await openEditor(page);
  const editor = sem(page, "routine-editor");

  // Webhook setup contains no schedule editor and never leaks the cron value
  // that remains behind the friendly schedule controls.
  await press(sem(page, "routine-source-webhook"));
  await expect.poll(() => spokenText(editor)).toContain("incoming webhooks");
  expect(await spokenText(editor)).not.toContain("0 9 * * *");

  // Schedule offers plain-language cadence and time controls on the same form.
  await press(sem(page, "routine-source-schedule"));
  await expect.poll(() => spokenText(editor)).toMatch(/Every day at 9:00\s?AM/iu);
  expect(await spokenText(editor)).not.toContain("0 9 * * *");

  await answer(page, {
    "routine.name": "Morning brief",
    "routine.prompt": "Summarise overnight email.",
  });
  await press(action(page, "save-routine"));
  const card = group(page, "Morning brief");
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
  });
  await press(action(page, "save-routine"));
  const card = group(page, "Morning brief");
  await expect(card).toBeVisible({ timeout: 60_000 });

  // Delete is on the editor the row opens: a row is what is armed and the
  // switch that pauses it, and everything else one Routine can be asked is
  // one press further in. The press is aimed at the row's words rather than
  // at its centre: the switch at the end of it is tappable too.
  await card.click({ position: { x: 24, y: 20 } });
  await expect(sem(page, "routine-editor")).toBeVisible();
  await press(action(page, "delete-routine"));
  const confirm = sem(page, "routine-delete-confirm");
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText("run log");

  // Cancelling keeps the Routine and stays on the editor — the list is one
  // page back. That it survived is checked here rather than while the
  // confirmation is up: a modal takes the surface behind it out of the
  // accessibility tree, so there is nothing to count until it closes.
  await confirm.getByText("Cancel").click();
  await expect(confirm).toHaveCount(0);
  await expect(sem(page, "routine-editor")).toBeVisible();
  await expect(documentField(page, "routine.name")).toBeVisible();

  // Confirming is what deletes it, and the editor pops back to the list.
  await press(action(page, "delete-routine"));
  await confirm.getByText("Delete Routine").click();
  await expect(card).toHaveCount(0, { timeout: 60_000 });
  await expect
    .poll(async () => await spokenText(document))
    .toContain("No Routines yet");
});
