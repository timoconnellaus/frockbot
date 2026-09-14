// The sidebar's own header, and the one rule about grouping the Bot list: a
// label group is not a thing a person configures, it appears the moment a
// visible Bot has a label and not before. The grouping arithmetic is
// `groupSidebarBots`'s and its unit tests cover it; what only a browser can
// show is that the durable field the settings panel writes is the field the
// sidebar reads back, and that search is a sidebar control rather than a
// second one hidden in the header.
import {
  closeOverlay,
  createBot,
  expect,
  openApplication,
  sem,
  test,
} from "./fixtures.ts";
import type { Page } from "@playwright/test";

/** The Bot rows the sidebar is showing, whichever group they are drawn in. */
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

test("the sidebar searches from the top and groups Bots only after a label exists", async ({
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

  // Two unlabelled Bots are one plain list: a single group, and no heading.
  const groups = sidebar.locator(
    '[flt-semantics-identifier^="sidebar-group-"]',
  );
  await expect(groups).toHaveCount(1);
  await expect(groups).not.toHaveAttribute("aria-label", /\S/);

  // The label is written the way the settings panel writes it. A heading is
  // what the sidebar does with it, and that is what this test is about.
  const botId = await botIdOf(page, "Beta");
  const settingsResponse = await page.request.get(
    `/api/bots/${encodeURIComponent(botId)}/settings`,
  );
  expect(settingsResponse.ok()).toBe(true);
  const settings = (await settingsResponse.json()) as { revision: number };
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
  await expect(sidebar).toBeVisible();
  // A heading is prose the group carries as its label rather than as text, so
  // it is read off `aria-label` — and the engine lists the groups in traversal
  // order, which is the order they are drawn in. Unassigned is always last.
  await expect(groups).toHaveCount(2);
  await expect(groups.nth(0)).toHaveAttribute("aria-label", "PERSONAL");
  await expect(groups.nth(1)).toHaveAttribute("aria-label", "UNASSIGNED");
  await expect(groups.nth(0).getByText("Beta")).toBeVisible();
  await expect(groups.nth(1).getByText("Alpha")).toBeVisible();
});
