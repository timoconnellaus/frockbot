// The Routines panel, through the browser: the two places it used to fail a
// person quietly.
//
// Both were found by dogfooding, and neither could be seen from a unit test.
// The write path already refused a bad schedule correctly and the delete
// command already worked — what was missing was the browser telling anyone.
// A refusal rendered in the section header, which sits above every Routine
// card, so on a real Bot it painted hundreds of pixels above the form and the
// form simply appeared to do nothing. And Delete went straight through from a
// single click, in a row of six other buttons, taking the schedule, the
// prompt and the whole run log with it.
import { test, expect, provisionThroughUi } from "./fixtures.ts";
import { E2E_OLLAMA_GOOD_API_KEY } from "./harness.ts";
import type { Locator, Page } from "@playwright/test";

/** The Routines section inside the Bot settings panel. */
function routines(page: Page): Locator {
  return page.locator("section.routines");
}

test("a refused schedule says why, next to the field that caused it", async ({
  page,
  userId,
  ollamaBaseUrl,
  allowedFailures,
}) => {
  // The refusal is a real 400 from the write path; the spec is about what the
  // browser does with it.
  allowedFailures.requests.push(/\/api\/bots\/[^/]+\/routines$/u);
  allowedFailures.console.push(/Failed to load resource.*400/u);

  await provisionThroughUi(page, {
    userId,
    apiKey: E2E_OLLAMA_GOOD_API_KEY,
    apiBaseUrl: ollamaBaseUrl,
    botName: "Scheduler",
  });
  await page.getByRole("button", { name: "Bot settings" }).click();
  const section = routines(page);
  await expect(section).toBeVisible();

  await section.getByRole("button", { name: "New Routine" }).click();
  const form = section.locator(".routine-form");
  await expect(form).toBeVisible();

  // The form defaults the time zone to the browser's own, not UTC: a schedule
  // is meant in the day the person writing it is living in.
  const timezone = form.getByLabel("Time zone");
  await expect(timezone).not.toHaveValue("UTC");
  await expect(timezone).toHaveValue(
    await page.evaluate(
      () => new Intl.DateTimeFormat().resolvedOptions().timeZone,
    ),
  );

  await form.getByLabel("Name", { exact: true }).fill("Blursday brief");
  await form.getByLabel("Prompt").fill("Summarise overnight email.");
  await form.getByLabel("Schedule").fill("every Blursday");
  await form.getByRole("button", { name: "Save Routine" }).click();

  // The reason arrives inside the form, and it is the real one.
  const refusal = form.locator("#routine-schedule-error");
  await expect(refusal).toBeVisible();
  await expect(refusal).toContainText("five fields");
  await expect(form.getByLabel("Schedule")).toHaveAttribute(
    "aria-invalid",
    "true",
  );

  // And it is on screen with the field, not scrolled off above the cards.
  const box = await refusal.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThan(0);
  expect(box!.y).toBeLessThan(viewport!.height);

  // Nothing was stored, and the form is still open with the value to correct.
  await expect(section.locator(".routine-card")).toHaveCount(0);
  await expect(form.getByLabel("Schedule")).toHaveValue("every Blursday");

  // Correcting it saves, and the refusal goes with it.
  await form.getByLabel("Schedule").fill("0 9 * * *");
  await form.getByRole("button", { name: "Save Routine" }).click();
  await expect(section.locator(".routine-card")).toHaveCount(1);
  await expect(section.getByText("Blursday brief")).toBeVisible();

  // The moment reads as a moment, not as the wire.
  const nextRun = section.locator(".routine-card__facts time").first();
  await expect(nextRun).toBeVisible();
  await expect(nextRun).not.toContainText("T");
  await expect(nextRun).toHaveAttribute("datetime", /^\d{4}-\d{2}-\d{2}T/u);
});

test("deleting a Routine asks first, and Cancel keeps it", async ({
  page,
  userId,
  ollamaBaseUrl,
}) => {
  await provisionThroughUi(page, {
    userId,
    apiKey: E2E_OLLAMA_GOOD_API_KEY,
    apiBaseUrl: ollamaBaseUrl,
    botName: "Keeper",
  });
  await page.getByRole("button", { name: "Bot settings" }).click();
  const section = routines(page);

  await section.getByRole("button", { name: "New Routine" }).click();
  const form = section.locator(".routine-form");
  await form.getByLabel("Name", { exact: true }).fill("Morning brief");
  await form.getByLabel("Prompt").fill("Summarise overnight email.");
  await form.getByLabel("Schedule").fill("0 9 * * *");
  await form.getByRole("button", { name: "Save Routine" }).click();
  const card = section.locator(".routine-card");
  await expect(card).toHaveCount(1);

  // One click used to be the whole of it. Now it asks, and names the Routine.
  await card.getByRole("button", { name: "Delete", exact: true }).click();
  const confirm = section.getByRole("alertdialog", {
    name: "Delete Morning brief?",
  });
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText("run log");
  await expect(card).toHaveCount(1);

  // Cancelling keeps it, and leaves the panel exactly as it was.
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toBeHidden();
  await expect(section.getByText("Morning brief")).toBeVisible();

  // Confirming is what deletes it.
  await card.getByRole("button", { name: "Delete", exact: true }).click();
  await section
    .getByRole("alertdialog")
    .getByRole("button", { name: "Delete Routine" })
    .click();
  await expect(section.locator(".routine-card")).toHaveCount(0);
  await expect(section.getByText("No Routines yet.")).toBeVisible();
});
