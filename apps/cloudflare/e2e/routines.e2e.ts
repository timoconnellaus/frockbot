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

/**
 * The browser runs in a real zone that is not UTC, so "the form defaults to
 * the browser's zone" is a claim the spec can actually test. The CI runner's
 * own zone is UTC, where a default of UTC and a default of the browser's zone
 * are indistinguishable — this spec asserted "not UTC" and passed locally for
 * exactly that reason while failing on CI.
 */
test.use({ timezoneId: "Australia/Sydney" });

/**
 * Open Bot settings and reveal the Routines section, which lives under
 * Advanced — the same path `bot-settings.e2e.ts` walks.
 */
async function openRoutines(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Bot settings" }).click();
  const panel = page.getByRole("region", { name: "Settings" });
  await expect(panel).toBeVisible();
  await panel.getByText("Advanced").click();
  const section = page.locator("section.routines");
  await expect(section).toBeVisible();
  return section;
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
  const section = await openRoutines(page);

  await section.getByRole("button", { name: "New Routine" }).click();
  const form = section.locator(".routine-form");
  await expect(form).toBeVisible();

  // The form defaults the time zone to the browser's own, not UTC: a schedule
  // is meant in the day the person writing it is living in.
  const timezone = form.getByLabel("Time zone");
  await expect(timezone).toHaveValue("Australia/Sydney");
  await expect(timezone).toHaveValue(
    await page.evaluate(
      () => new Intl.DateTimeFormat().resolvedOptions().timeZone,
    ),
  );

  await form.getByLabel("Name", { exact: true }).fill("Blursday brief");
  await form.getByLabel("Prompt").fill("Summarise overnight email.");
  await form.getByLabel(/^Schedule/u).fill("every Blursday");
  await form.getByRole("button", { name: "Save Routine" }).click();

  // The reason arrives inside the form, and it is the real one.
  const refusal = form.locator("#routine-schedule-error");
  await expect(refusal).toBeVisible();
  await expect(refusal).toContainText("five fields");
  await expect(form.getByLabel(/^Schedule/u)).toHaveAttribute(
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
  await expect(form.getByLabel(/^Schedule/u)).toHaveValue("every Blursday");

  // Correcting it saves, and the refusal goes with it.
  await form.getByLabel(/^Schedule/u).fill("0 9 * * *");
  await form.getByRole("button", { name: "Save Routine" }).click();
  await expect(section.locator(".routine-card")).toHaveCount(1);
  await expect(section.getByText("Blursday brief")).toBeVisible();

  // The moment reads as a moment, not as the wire.
  const nextRun = section.locator(".routine-card__facts time").first();
  await expect(nextRun).toBeVisible();
  await expect(nextRun).not.toContainText("T");
  // Read in the Routine's own zone — the one it fires on — in the house
  // order: "3 Sep 2026, 9:00am", never "2026-09-03T23:00:00.000Z".
  await expect(nextRun).toContainText("9:00am");
  await expect(nextRun).toHaveText(/^\d{1,2} [A-Z][a-z]{2} \d{4}, 9:00am$/u);
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
  const section = await openRoutines(page);

  await section.getByRole("button", { name: "New Routine" }).click();
  const form = section.locator(".routine-form");
  await form.getByLabel("Name", { exact: true }).fill("Morning brief");
  await form.getByLabel("Prompt").fill("Summarise overnight email.");
  await form.getByLabel(/^Schedule/u).fill("0 9 * * *");
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

for (const scenario of [
  {
    connector: "Gmail",
    slug: "gmail",
    alias: "Work inbox",
    name: "New email summary",
    prompt: "Summarize the email that just arrived.",
    event: "When a new email arrives in Gmail",
    field: "Mailbox label",
    value: "Important",
  },
  {
    connector: "Google Calendar",
    slug: "googlecalendar",
    alias: "Work calendar",
    name: "Meeting brief",
    prompt: "Prepare a brief for the meeting that is about to start.",
    event: "Event starting soon in Google Calendar",
    field: "Minutes Before Start",
    value: "15",
  },
]) {
  test(`${scenario.connector} account event Routine uses named accounts, event fields and listening states`, async ({
    page,
    userId,
    ollamaBaseUrl,
  }) => {
    await provisionThroughUi(page, {
      userId,
      apiKey: E2E_OLLAMA_GOOD_API_KEY,
      apiBaseUrl: ollamaBaseUrl,
      botName: "Account helper",
    });
    // Authorize through the same backend start/callback protocol; the form itself only reads projections.
    const start = await page.request.post("/api/plugins/composio/connections", {
      headers: { "x-frockbot-user-id": userId },
      data: {
        schemaVersion: 1,
        type: "connection/start",
        commandId: `routine-ui-${scenario.slug}`,
        connectionTypeId: "app",
        connectorId: scenario.slug,
        alias: scenario.alias,
      },
    });
    expect(start.status()).toBe(201);
    const link = (await start.json()) as { redirectUrl: string };
    const callback = new URL(link.redirectUrl).searchParams.get("callback");
    if (!callback) throw new Error("Fake authorization callback is missing");
    expect(
      (await page.request.get(callback, { maxRedirects: 0 })).status(),
    ).toBe(303);
    const section = await openRoutines(page);
    await section.getByRole("button", { name: "New Routine" }).click();
    const form = section.locator(".routine-form");
    await form.getByLabel("Name", { exact: true }).fill(scenario.name);
    await form.getByLabel("Prompt").fill(scenario.prompt);
    await form.getByLabel("An event in a connected account").check();
    await expect(
      form.getByRole("combobox", { name: "Account", exact: true }),
    ).toContainText(`${scenario.connector} · ${scenario.alias}`);
    await form
      .getByRole("combobox", { name: "Account", exact: true })
      .selectOption({ label: `${scenario.connector} · ${scenario.alias}` });
    await form
      .getByRole("combobox", { name: /^When/ })
      .selectOption({ label: scenario.event });
    if (scenario.slug === "googlecalendar") {
      await expect(form.getByLabel("Calendar Id", { exact: true })).toHaveValue(
        "primary",
      );
      await expect(
        form.getByLabel("Countdown Window Minutes", { exact: true }),
      ).toHaveValue("60");
      await expect(
        form.getByLabel("Include All Day", { exact: true }),
      ).not.toBeChecked();
    }
    await form.getByLabel(scenario.field).fill(scenario.value);
    await expect(form).not.toContainText("Composio");
    await expect(form).not.toContainText("delivery key");
    await form.getByRole("button", { name: "Save Routine" }).click();
    const card = section
      .locator(".routine-card")
      .filter({ hasText: scenario.name });
    await expect(card.getByRole("status")).toHaveText("Listening");
    await expect(card).toContainText(scenario.event);
    await expect(card.getByRole("button", { name: "Mint key" })).toHaveCount(0);
    await card.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(card.getByRole("status")).toHaveText("Paused");
    await card.getByRole("button", { name: "Resume", exact: true }).click();
    await expect(card.getByRole("status")).toHaveText("Listening");
    await card.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(form.getByLabel(scenario.field)).toHaveValue(scenario.value);
    await form
      .getByRole("combobox", { name: "Account", exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `e2e/test-results/${scenario.slug}-routine.png`,
      fullPage: true,
      animations: "disabled",
    });
  });
}
