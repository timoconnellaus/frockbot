// The Package-composed default Bot panel and settings deep links (register
// rows 50 and 51). The page fixture also fails on any console or request error,
// which proves the Contributions can mount together rather than only that their
// individual components compile.
import { test, expect, provisionThroughUi } from "./fixtures.ts";
import { E2E_OLLAMA_GOOD_API_KEY } from "./harness.ts";

test("the default panel composes Computer and Routines and swaps to Settings", async ({
  page,
  userId,
  ollamaBaseUrl,
}) => {
  await page.setViewportSize({ width: 1351, height: 859 });
  await provisionThroughUi(page, {
    userId,
    apiKey: E2E_OLLAMA_GOOD_API_KEY,
    apiBaseUrl: ollamaBaseUrl,
    botName: "Observed",
  });

  const panel = page.getByRole("region", { name: "Bot panel" });
  await expect(panel).toBeVisible();
  await expect(panel.locator("section.computer-card")).toBeVisible();
  await expect(panel.getByText("Observed's screen")).toBeVisible();
  await expect(panel.getByText("Routines", { exact: true })).toBeVisible();
  await expect(panel.getByText("No Routines yet.")).toBeVisible();
  const routinesEditor = panel.getByRole("link", {
    name: "Open Routines editor",
  });
  await expect(routinesEditor).toBeVisible();
  await routinesEditor.click();

  const settings = page.getByRole("region", { name: "Settings" });
  await expect(settings.locator("#bot-routines")).toBeVisible();
  await settings.getByRole("button", { name: "Back to Bot panel" }).click();
  await expect(panel).toBeVisible();

  await page.getByRole("button", { name: "Bot settings" }).click();
  await expect(settings).toBeVisible();
  await expect(
    settings.getByRole("heading", { name: "Settings" }),
  ).toBeVisible();
  await expect(
    settings.getByRole("button", { name: "Back to Bot panel" }),
  ).toBeVisible();
  await expect(panel).toBeHidden();

  await settings.getByRole("button", { name: "Back to Bot panel" }).click();
  await expect(panel).toBeVisible();

  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test("the default panel and Settings fit the mobile shell", async ({
  page,
  userId,
  ollamaBaseUrl,
}) => {
  await provisionThroughUi(page, {
    userId,
    apiKey: E2E_OLLAMA_GOOD_API_KEY,
    apiBaseUrl: ollamaBaseUrl,
    botName: "Pocket",
  });
  await page.setViewportSize({ width: 390, height: 844 });

  // On a phone the right panel is a drawer, and a drawer that opened itself
  // over the conversation is the layout this replaced — so it starts closed
  // and the toggle is how it arrives. What this test is about is unchanged:
  // that the panel and Settings fit the window once they are on screen.
  await page.getByRole("button", { name: "Show side panel" }).click();

  const panel = page.getByRole("region", { name: "Bot panel" });
  await expect(panel).toBeVisible();
  await expect(panel.getByText("Pocket's screen")).toBeVisible();
  await page.getByRole("button", { name: "Bot settings" }).click();
  await expect(page.getByRole("region", { name: "Settings" })).toBeVisible();

  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test("settings and retired info-pane deep links resolve at their new homes", async ({
  page,
  userId,
  ollamaBaseUrl,
}) => {
  await provisionThroughUi(page, {
    userId,
    apiKey: E2E_OLLAMA_GOOD_API_KEY,
    apiBaseUrl: ollamaBaseUrl,
    botName: "Linked",
  });

  const botId = await page.evaluate(
    () => new URL(window.location.href).searchParams.get("bot") ?? "",
  );
  expect(botId).not.toBe("");

  await page.goto(
    `/?bot=${encodeURIComponent(botId)}&settings=bot-settings#bot-description`,
  );
  const settings = page.getByRole("region", { name: "Settings" });
  const description = settings.locator("#bot-description");
  await expect(description).toBeVisible();
  await expect(description).toHaveAttribute("data-anchor-target", "true");

  await page.goto(
    `/?bot=${encodeURIComponent(botId)}&settings=bot-settings#bot-audit`,
  );
  await expect(settings.locator("#bot-audit")).toBeVisible();

  await page.goto(
    `/?bot=${encodeURIComponent(botId)}&settings=bot-settings#bot-info-members`,
  );
  await expect(settings.locator("#bot-info-members")).toBeVisible();
  await expect(settings.getByText("Named by you")).toBeVisible();

  await page.goto(
    `/?bot=${encodeURIComponent(botId)}&settings=bot-panel#bot-info-computer`,
  );
  const panel = page.getByRole("region", { name: "Bot panel" });
  await expect(panel).toBeVisible();
  await expect(panel.locator("#bot-info-computer")).toHaveAttribute(
    "data-anchor-target",
    "true",
  );
  await expect(
    panel.getByRole("button", { name: "Copy link to Computer" }),
  ).toBeAttached();
});
