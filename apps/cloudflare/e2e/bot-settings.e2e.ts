// Seam S6 (the app manifest the application Worker produces against the plugin
// catalog decoder the client ships) plus the Bot settings projection of S3.
//
// Incidents 2 and 3 were both here: the producer emitted a Package without a
// `configuration` block, or with a `deployment.applicationHash` the decoder
// refused, and the Bot settings panel came up with an error banner instead of
// the Assignment catalog. Producer and consumer each had passing unit tests.
//
// The Bot settings panel has no turns list — the conversation is the window
// beside it — so the Turn history assertion lives in `chat.e2e.ts`, and this
// spec asserts the panel and the catalog it decodes.
import { test, expect, provisionThroughUi, sendMessage } from "./fixtures.ts";
import { E2E_OLLAMA_GOOD_API_KEY } from "./harness.ts";

test("Bot settings follows the GrokBot order and keeps extras under Advanced", async ({
  page,
  userId,
  ollamaBaseUrl,
}) => {
  await provisionThroughUi(page, {
    userId,
    apiKey: E2E_OLLAMA_GOOD_API_KEY,
    apiBaseUrl: ollamaBaseUrl,
    botName: "Inspected",
  });

  // A Bot with history, so the panel opens beside a conversation that had to
  // load rather than beside an empty thread.
  await sendMessage(page, "hello");

  await page.getByRole("button", { name: "Bot settings" }).click();
  const panel = page.getByRole("region", { name: "Settings" });
  await expect(panel).toBeVisible();
  await expect(
    panel.getByRole("img", { name: "Inspected avatar" }),
  ).toBeVisible();
  await expect(panel.getByRole("button", { name: "Change" })).toBeVisible();
  await expect(panel.getByRole("button", { name: /upload/iu })).toHaveCount(0);
  await expect(panel.getByLabel("Name", { exact: true })).toHaveValue(
    "Inspected",
  );
  await expect(panel.getByLabel("Label", { exact: true })).toHaveAttribute(
    "placeholder",
    "Research, marketing, admin",
  );
  await expect(panel.getByLabel("Description", { exact: true })).toBeVisible();
  await expect(
    panel.getByText("Get notified when this Bot finishes or needs input"),
  ).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Share as template" }),
  ).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Save settings" }),
  ).toBeVisible();
  await expect(panel.getByLabel("Title", { exact: true })).toBeHidden();

  // The Assignment catalog is the client's decode of `/app-manifest`. A Package
  // the decoder refused would leave this section empty and the banner set.
  await panel.getByText("Advanced").click();
  await expect(panel.getByLabel("Title", { exact: true })).toBeVisible();
  await expect(panel.getByText("Members", { exact: true })).toBeVisible();
  await expect(panel.getByText("Named by user")).toBeVisible();
  await expect(panel.getByText("Capability Assignments")).toBeVisible();
  await expect(
    panel.getByText("Ollama Cloud · ollama-cloud-models"),
  ).toBeVisible();
  await expect(
    panel.getByLabel("Connection for ollama-cloud-models"),
  ).toBeVisible();
  await expect(panel.getByText("Routines", { exact: true })).toBeVisible();
  await expect(panel.getByText("Audit log", { exact: true })).toBeVisible();
  await expect(panel.getByText("Import a Bot template")).toBeVisible();

  // No error banner anywhere in the panel, and — through the `page` fixture —
  // no console error and no failed request during any of it.
  await expect(panel.locator("p.settings-error")).toHaveCount(0);
  await expect(page.locator("p.connection-failure")).toHaveCount(0);
});
