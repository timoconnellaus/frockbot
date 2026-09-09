import type { Locator, Page } from "@playwright/test";
import {
  chooseDefaultModel,
  chooseOllamaProvider,
  closeOverlay,
  connectOllama,
  E2E_CONNECTION_LABEL,
  E2E_MODEL_LABEL,
  expect,
  group,
  field,
  openApplication,
  openProfileMenu,
  sem,
  SHELL_TIMEOUT_MS,
  test,
} from "./fixtures.ts";
import { E2E_OLLAMA_GOOD_API_KEY } from "./harness.ts";

/**
 * Press a named widget.
 *
 * A `Semantics(identifier:)` around a widget that lays itself out — a view
 * action's `Align`, a `Card`'s `ListTile` — reaches the accessibility tree as
 * a container with `pointer-events: none`, and the node that takes the tap is
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

/** Something a person can press, by the words on it. */
function pressable(page: Page, text: string) {
  return page.locator("[flt-tappable]").filter({ hasText: text }).first();
}

/**
 * A live region's words.
 *
 * A `Semantics(liveRegion:)` wraps the text it announces rather than being it,
 * so the sentence reaches the accessibility tree as that node's accessible
 * name and not as text a reader could select.
 */
function announcement(page: Page, text: string) {
  return page.locator(`[aria-label="${text}"]`);
}

/**
 * Open one entry of the profile sheet, and be sure that is where it landed.
 *
 * The sheet slides in, and Flutter hit-tests a press against the frame it is
 * painting rather than against the accessibility tree Playwright read a frame
 * earlier — so a press aimed at one row while the sheet is still moving opens
 * whichever row has arrived under it. Three of these entries open a surface
 * that calls itself a settings document, so each is confirmed by a widget only
 * it draws, and a press that missed is retried from the conversation.
 */
async function openProfileSurface(
  page: Page,
  entry: string,
  marker: string,
): Promise<void> {
  await expect(async () => {
    if (
      !(await sem(page, "sidebar-profile")
        .isVisible()
        .catch(() => false))
    ) {
      await page.goBack();
    }
    await openProfileMenu(page);
    await settle(page);
    await tap(page, entry).click();
    await expect(sem(page, marker)).toBeVisible({ timeout: 20_000 });
  }).toPass({ timeout: 120_000 });
  await settle(page);
}

/** Models: the account's default model, and the providers behind it. */
async function openModels(page: Page): Promise<void> {
  await openProfileSurface(page, "profile-models", "settings-model-field");
}

/**
 * Choose Ollama Cloud as a provider for this account.
 *
 * Connectors offers a provider's connect form only once that provider's own
 * Package is installed, and Ollama Cloud is not a row in Plugins: it is
 * offered on Models, as the action beside the provider's own name. That action
 * is scoped to its group rather than named, because its id carries the
 * section's index in the document and a spec has no business knowing that.
 */

/** Account Settings, which is the only surface carrying the Models link. */
async function openSettings(page: Page): Promise<void> {
  await openProfileSurface(page, "profile-settings", "settings-document");
}

test("Models chooses the account default with the Bot override Package disabled", async ({
  page,
  userId,
  ollamaBaseUrl,
}) => {
  await openApplication(page, userId);
  // Custom models — the Package that lets one *Bot* differ from the account —
  // is a separate switch from the provider's own, and this test is here to say
  // it stays off.
  await chooseOllamaProvider(page);
  await connectOllama(page, {
    apiKey: E2E_OLLAMA_GOOD_API_KEY,
    apiBaseUrl: ollamaBaseUrl,
  });

  const label = `${E2E_MODEL_LABEL} · ${E2E_CONNECTION_LABEL}`;
  await chooseDefaultModel(page, label);

  const settings = await (
    await page.request.get("/api/settings?view=2")
  ).json();
  expect(settings.accountModel.providerModelId).toBe("gpt-oss:20b");
  expect(
    settings.packages.find(
      (p: { packageId: string }) => p.packageId === "custom-models",
    ).state,
  ).toBe("disabled");

  // And the surface says so on its own terms, read fresh.
  await openModels(page);
  await expect(sem(page, "settings-model-field")).toContainText(label);
});

test("an uncertain profile save survives reload and checks the original command", async ({
  page,
  userId,
  allowedFailures,
}) => {
  allowedFailures.requests.push(/\/api\/settings\/application/u);
  allowedFailures.console.push(/Failed to load resource.*ERR_FAILED/u);
  await openApplication(page, userId);
  await openSettings(page);

  const name = field(sem(page, "settings-document"), "view-field-f0.name");
  await name.click();
  await name.fill("Saved through interruption");

  let firstId: string | undefined;
  await page.route(
    "**/api/settings/application",
    async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const body = route.request().postDataJSON();
      firstId = body.commandId;
      expect(body.ownerId).toBe(userId);
      await route.fetch(); // The real User owner commits before the reply is lost.
      await route.abort("failed");
    },
    { times: 1 },
  );
  await tap(sem(page, "settings-document"), "view-action-save-0").click();

  // The reply never arrived, so the command is retained rather than replaced:
  // the surface offers to check the one it already sent.
  await expect(page.getByText("Check that action")).toBeVisible({
    timeout: 60_000,
  });
  const committed = await (
    await page.request.get("/api/settings?view=2")
  ).json();

  await page.reload();
  await expect(
    sem(page, "shell-sidebar").or(sem(page, "sidebar-toggle")),
  ).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  // The owner committed, so the name is the account's even though the client
  // never heard so.
  await openProfileMenu(page);
  await expect(sem(page, "profile-name")).toContainText(
    "Saved through interruption",
  );
  await page.keyboard.press("Escape");
  await settle(page);
  await openSettings(page);

  let replayId: string | undefined;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/settings/application"
    )
      replayId = request.postDataJSON().commandId;
  });
  await pressable(page, "Check that action").click();
  await expect(announcement(page, "Done.")).toBeVisible({ timeout: 60_000 });
  expect(replayId).toBe(firstId);
  expect(
    (await (await page.request.get("/api/settings?view=2")).json()).revision,
  ).toBe(committed.revision);
});
