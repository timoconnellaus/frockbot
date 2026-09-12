import {
  test,
  expect,
  createBot,
  field,
  openApplication,
  press,
  sem,
  settle,
} from "./fixtures.ts";

test("search opens from the field or keyboard and selects a Bot without sending the composer draft", async ({
  page,
  userId,
}, testInfo) => {
  await openApplication(page, userId);
  await createBot(page, "School");
  await createBot(page, "Housework");
  const overlay = sem(page, "search-overlay");
  await press(sem(page, "sidebar-search"));
  await expect(overlay).toBeVisible();
  await expect(sem(page, "search-category-actions")).toBeVisible();
  await settle(page);
  await page.screenshot({ path: testInfo.outputPath("search-desktop.png") });
  await page.keyboard.press("Escape");
  await expect(overlay).toBeHidden();

  const composer = field(page, "chat-composer");
  await composer.focus();
  await composer.pressSequentially("Unsent draft");
  await page.keyboard.press("ControlOrMeta+k");
  await expect(overlay).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  await expect(overlay).toHaveCount(1);
  const query = field(page, "search-field");
  await query.focus();
  await query.pressSequentially("School");
  const bot = overlay.locator('[flt-semantics-identifier^="search-bot-"]');
  await expect(bot).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(overlay).toBeHidden();
  const sidebarBots = sem(page, "shell-sidebar").locator(
    '[flt-semantics-identifier^="sidebar-bot-"]',
  );
  await expect(sidebarBots.filter({ hasText: "School" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await press(sidebarBots.filter({ hasText: "Housework" }));
  await composer.focus();
  await expect(composer).toHaveValue("Unsent draft");
});

test("phone search fills the screen and changes categories through the filter menu", async ({
  page,
  userId,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApplication(page, userId);
  await press(sem(page, "sidebar-search"));
  const overlay = sem(page, "search-overlay");
  await expect(overlay).toBeVisible();
  await press(sem(page, "search-filter"));
  await expect(sem(page, "search-category-routines")).toBeVisible();
  await settle(page);
  await page.screenshot({
    path: testInfo.outputPath("search-phone-filter.png"),
  });
  await press(sem(page, "search-category-files"));
  await expect(sem(page, "search-category-routines")).toBeHidden();
  await expect(sem(page, "search-filter")).toBeVisible();
  await press(sem(page, "search-close"));
  await expect(overlay).toBeHidden();
  await expect(sem(page, "shell-sidebar")).toBeVisible();
});
