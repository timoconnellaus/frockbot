// The sidebar's own header, and the one list beneath it. Search is a sidebar
// control rather than a second one hidden in the header, and the Bots are one
// list in their sidebar order: there are no label headings. An installed app
// still sends the retired label on every settings save, and what only a
// browser can show is that the save is accepted and changes nothing the
// sidebar draws.
import {
  closeOverlay,
  createBot,
  expect,
  openApplication,
  sem,
  test,
} from "./fixtures.ts";
import type { Page } from "@playwright/test";

/** The Bot rows the sidebar is showing. */
function rows(page: Page) {
  return sem(page, "shell-sidebar").locator(
    '[flt-semantics-identifier^="sidebar-bot-"]',
  );
}

/** The durable Bot id behind the row showing `name`. */
async function botIdOf(page: Page, name: string): Promise<string> {
  const row = rows(page).filter({ hasText: name });
  await expect(row).toHaveCount(1);
  const identifier = await row.getAttribute("flt-semantics-identifier");
  if (!identifier) throw new Error(`the ${name} row has no identifier`);
  return identifier.slice("sidebar-bot-".length);
}

test("the sidebar searches from the top and lists every Bot in one list", async ({
  page,
  userId,
}) => {
  await openApplication(page, userId);

  // Search sits below the sidebar's header as a full-width input, and is the
  // only search trigger in the shell: there is no second one in the top bar.
  const sidebar = sem(page, "shell-sidebar");
  const search = sem(page, "sidebar-search");
  const createButton = sem(page, "sidebar-create-bot");
  await expect(search).toHaveCount(1);
  await expect(
    sidebar.locator('[flt-semantics-identifier="sidebar-search"]'),
  ).toHaveCount(1);
  const [searchBox, createButtonBox] = await Promise.all([
    search.boundingBox(),
    createButton.boundingBox(),
  ]);
  if (!searchBox || !createButtonBox) {
    throw new Error("the sidebar controls are missing geometry");
  }
  expect(searchBox.y).toBeGreaterThanOrEqual(
    createButtonBox.y + createButtonBox.height,
  );
  expect(searchBox.width).toBeGreaterThan(createButtonBox.width * 3);

  await search.click();
  await expect(sem(page, "search-overlay")).toBeVisible();
  await closeOverlay(page);

  await createBot(page, "Alpha");
  await createBot(page, "Beta");

  // The save an installed app makes: the whole profile, the label included.
  const botId = await botIdOf(page, "Beta");
  const settingsResponse = await page.request.get(
    `/api/bots/${encodeURIComponent(botId)}/settings`,
  );
  expect(settingsResponse.ok()).toBe(true);
  const settings = (await settingsResponse.json()) as { revision: number };
  const saved = await page.request.post(
    `/api/bots/${encodeURIComponent(botId)}/settings`,
    {
      data: {
        schemaVersion: 1,
        type: "bot/set-profile",
        commandId: `label-${crypto.randomUUID()}`,
        expectedRevision: settings.revision,
        botId,
        profile: { name: "Beta", label: "Personal" },
      },
    },
  );
  expect(saved.ok()).toBe(true);
  const reread = await page.request.get(
    `/api/bots/${encodeURIComponent(botId)}/settings`,
  );
  expect(
    ((await reread.json()) as { profile: object }).profile,
  ).not.toHaveProperty("label");

  await page.reload();
  await expect(sidebar).toBeVisible();
  // The rows are where they were, and no heading is drawn for the label.
  await expect(rows(page).filter({ hasText: "Alpha" })).toHaveCount(1);
  await expect(rows(page).filter({ hasText: "Beta" })).toHaveCount(1);
  await expect(sidebar.getByText("PERSONAL")).toHaveCount(0);
});
