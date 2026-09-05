import {
  test,
  expect,
  openApplication,
  firstRunDialog,
  connectOllama,
  closeOverlay,
  chooseDefaultModel,
  openModels,
  E2E_MODEL_LABEL,
  E2E_CONNECTION_LABEL,
} from "./fixtures.ts";
import { E2E_OLLAMA_GOOD_API_KEY } from "./harness.ts";

test("Models chooses the account default with the Bot override Package disabled", async ({
  page,
  userId,
  ollamaBaseUrl,
}) => {
  await openApplication(page, userId);
  await firstRunDialog(page).getByRole("button", { name: "Cancel" }).click();
  await connectOllama(page, {
    apiKey: E2E_OLLAMA_GOOD_API_KEY,
    apiBaseUrl: ollamaBaseUrl,
  });
  await expect(page.getByText("Ready · model list up to date")).toBeVisible();
  await closeOverlay(page);
  await chooseDefaultModel(
    page,
    `${E2E_MODEL_LABEL} — ${E2E_CONNECTION_LABEL}`,
  );
  const settings = await (
    await page.request.get("/api/settings?view=2")
  ).json();
  expect(settings.accountModel.providerModelId).toBe("gpt-oss:20b");
  expect(
    settings.packages.find(
      (p: { packageId: string }) => p.packageId === "custom-models",
    ).state,
  ).toBe("disabled");
  await openModels(page);
  await expect(
    page
      .locator("form.frame-section")
      .getByRole("button", {
        name: `Model: ${E2E_MODEL_LABEL} · ${E2E_CONNECTION_LABEL}`,
        exact: true,
      }),
  ).toHaveText(`${E2E_MODEL_LABEL} · ${E2E_CONNECTION_LABEL}`);
});

test("an uncertain profile save survives reload and checks the original command", async ({
  page,
  userId,
  allowedFailures,
}) => {
  allowedFailures.requests.push(/\/api\/settings\/application/u);
  allowedFailures.console.push(/Failed to load resource.*ERR_FAILED/u);
  await openApplication(page, userId);
  await firstRunDialog(page).getByRole("button", { name: "Cancel" }).click();
  const openSettings = async () => {
    await page.locator("button.profile-trigger").click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  };
  await openSettings();
  const region = page.getByRole("region", { name: "Settings", exact: true });
  await region
    .getByLabel("Name", { exact: true })
    .fill("Saved through interruption");
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
  await region
    .getByRole("button", { name: "Save profile", exact: true })
    .click();
  await expect(
    region.getByRole("button", { name: "Check save", exact: true }),
  ).toBeVisible();
  const committed = await (
    await page.request.get("/api/settings?view=2")
  ).json();
  await page.reload();
  await firstRunDialog(page).getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator("button.profile-trigger")).toHaveText(
    "Saved through interruption",
  );
  await openSettings();
  let replayId: string | undefined;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/settings/application"
    )
      replayId = request.postDataJSON().commandId;
  });
  await region.getByRole("button", { name: "Check save", exact: true }).click();
  await expect(region.getByRole("status")).toContainText("Saved.");
  expect(replayId).toBe(firstId);
  expect(
    (await (await page.request.get("/api/settings?view=2")).json()).revision,
  ).toBe(committed.revision);
});
