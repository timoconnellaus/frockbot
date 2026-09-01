import {
  closeOverlay,
  createBot,
  expect,
  firstRunDialog,
  openApplication,
  test,
} from "./fixtures.ts";

test("the sidebar searches from the top and groups Bots only after a label exists", async ({
  page,
  userId,
}) => {
  await openApplication(page, userId);
  await firstRunDialog(page).getByRole("button", { name: "Cancel" }).click();

  const sidebar = page.locator("aside.sidebar");
  const search = sidebar.getByRole("button", {
    name: "Search every Bot's conversations",
  });
  await expect(search).toBeVisible();
  await expect(
    page.locator("header.topbar").getByRole("button", { name: /Search/ }),
  ).toHaveCount(0);
  await search.click();
  await expect(page.getByRole("heading", { name: "Search" })).toBeVisible();
  await closeOverlay(page);

  await createBot(page, "Alpha");
  await createBot(page, "Beta");
  await expect(sidebar.locator(".flock-group-heading")).toHaveCount(0);

  const botId = new URL(page.url()).searchParams.get("bot");
  if (!botId) throw new Error("the selected Bot is missing from the URL");
  const settingsResponse = await page.request.get(
    `/api/bots/${encodeURIComponent(botId)}/settings`,
  );
  expect(settingsResponse.ok()).toBe(true);
  const settings = (await settingsResponse.json()) as {
    revision: number;
  };
  const labelled = await page.request.post(
    `/api/bots/${encodeURIComponent(botId)}/settings`,
    {
      data: {
        schemaVersion: 1,
        type: "bot/set-profile",
        commandId: `label-${crypto.randomUUID()}`,
        expectedRevision: settings.revision,
        botId,
        profile: { label: "Personal" },
      },
    },
  );
  expect(labelled.ok()).toBe(true);

  await page.reload();
  await expect(sidebar.locator(".flock-group-heading")).toHaveText([
    "Personal",
    "Unassigned",
  ]);
});
