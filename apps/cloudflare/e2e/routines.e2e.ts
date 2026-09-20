// The Routines panel, through the browser: a list and a read-only detail,
// friendly schedules, and a destructive action that always asks first.
//
// Routines is a server-projected document, so every control here is named by
// the projection's own ids — `view-field-routine.*`, `view-action-*` and the
// group a Routine's name slugs to — and only the confirmation is host chrome
// with a name of its own. Conversation is the only author; a spec that needs a
// Routine already there creates it through the command route.
import {
  test,
  expect,
  action,
  createBot,
  createRoutineThroughApi,
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
 * Open the Routines surface through the All Routines row on the Bot page —
 * the one door to the list at every tier, so it is the door this spec uses.
 */
async function openRoutines(page: Page): Promise<Locator> {
  await press(sem(page, "bot-page-routines-all").first());
  const document = sem(page, "routines-document");
  await expect(document).toBeVisible({ timeout: 60_000 });
  return document;
}

/** The detail a row opens. A surface someone came to read is not a form. */
async function openDetail(page: Page, name: string): Promise<void> {
  const card = group(page, name);
  await expect(card).toBeVisible({ timeout: 60_000 });
  // The press is aimed at the row's words rather than at its centre: the
  // switch at the end of it is tappable too.
  await card.click({ position: { x: 24, y: 20 } });
  await expect(documentField(page, "routine.name")).toBeVisible();
}

test("the list is not a form, and schedules stay human", async ({
  page,
  userId,
}) => {
  await openApplication(page, userId);
  await createBot(page, "Scheduler");
  const empty = await openRoutines(page);
  await expect
    .poll(() => spokenText(empty))
    .toContain("Ask this Bot to set up a Routine.");
  await expect(sem(page, "routine-create")).toHaveCount(0);

  await createRoutineThroughApi(page, {
    botName: "Scheduler",
    name: "Morning brief",
    prompt: "Summarise overnight email.",
    schedule: "0 9 * * *",
  });
  await press(sem(page, "routines-refresh"));
  const card = group(page, "Morning brief");
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(sem(page, "routine-create")).toHaveCount(0);

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
  await createRoutineThroughApi(page, {
    botName: "Keeper",
    name: "Morning brief",
    prompt: "Summarise overnight email.",
    schedule: "0 9 * * *",
  });
  const document = await openRoutines(page);
  const card = group(page, "Morning brief");
  await expect(card).toBeVisible({ timeout: 60_000 });

  // Delete is on the detail the row opens: a row is what is armed and the
  // switch that pauses it, and everything else one Routine can be asked is
  // one press further in.
  await openDetail(page, "Morning brief");
  await press(action(page, "delete-routine"));
  const confirm = sem(page, "routine-delete-confirm");
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText("run log");

  // Cancelling keeps the Routine and stays on the detail — the list is one
  // page back. That it survived is checked here rather than while the
  // confirmation is up: a modal takes the surface behind it out of the
  // accessibility tree, so there is nothing to count until it closes.
  await confirm.getByText("Cancel").click();
  await expect(confirm).toHaveCount(0);
  await expect(documentField(page, "routine.name")).toBeVisible();

  // Confirming is what deletes it, and the detail pops back to the list.
  await press(action(page, "delete-routine"));
  await confirm.getByText("Delete Routine").click();
  await expect(card).toHaveCount(0, { timeout: 60_000 });
  await expect
    .poll(async () => await spokenText(document))
    .toContain("No Routines yet");
});
