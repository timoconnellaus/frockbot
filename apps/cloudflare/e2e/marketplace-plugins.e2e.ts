import type { Locator, Page, TestInfo } from "@playwright/test";
import {
  expect,
  group,
  openApplication,
  openConnectors,
  press,
  revealSidebar,
  sem,
  sendMessage,
  settle,
  spokenText,
  test,
} from "./fixtures.ts";

function action(scope: Page | Locator, actionId: string): Locator {
  return sem(scope, `view-action-${actionId}`);
}

async function capture(
  page: Page,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  const path = testInfo.outputPath(name);
  await page.screenshot({ path });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

function details(scope: Page | Locator): Locator {
  return sem(scope, "view-group-details-controls");
}

async function revealAction(
  scope: Page | Locator,
  actionId: string,
): Promise<void> {
  const target = action(scope, actionId);
  if (!(await target.isVisible().catch(() => false))) {
    await press(details(scope));
  }
  await expect(target).toBeVisible();
}

async function openBotList(page: Page): Promise<void> {
  // General can replace the initial phone list while the account loads.
  await expect(async () => {
    await revealSidebar(page);
    await expect(sem(page, "sidebar-marketplace")).toBeVisible({
      timeout: 1_000,
    });
  }).toPass({ timeout: 120_000 });
  await settle(page);
}

test("Marketplace installs, sets up, removes, and leaves a fresh Bot usable", async ({
  page,
  userId,
}, testInfo) => {
  await openApplication(page, userId);
  await openBotList(page);

  await openConnectors(page);
  await capture(page, testInfo, "marketplace-connectors.png");
  await press(sem(page, "marketplace-plugins-tab"));
  await settle(page);
  const marketplace = sem(page, "marketplace-plugins-document");
  await expect(marketplace).toBeVisible();
  const deepSeek = group(page, "DeepSeek");
  await expect(deepSeek).toBeVisible();
  await expect.poll(() => spokenText(deepSeek)).toContain("Not installed");
  await capture(page, testInfo, "marketplace-deepseek-not-installed.png");

  await revealAction(deepSeek, "install-package");
  await press(action(deepSeek, "install-package"));
  await expect.poll(() => spokenText(deepSeek)).toContain("Installed");
  await capture(page, testInfo, "marketplace-deepseek-installed.png");

  await press(sem(page, "right-panel-close"));
  await expect(sem(page, "shell-conversation")).toBeVisible();
  await openConnectors(page);
  await press(sem(page, "marketplace-plugins-tab"));
  await settle(page);
  await expect(marketplace).toBeVisible();
  await expect.poll(() => spokenText(deepSeek)).toContain("Installed");

  await revealAction(deepSeek, "open-home");
  await press(action(deepSeek, "open-home"));
  await expect(sem(page, "settings-model-field")).toBeVisible();
  await capture(page, testInfo, "marketplace-deepseek-model-setup.png");
  await page.goBack();
  await expect(marketplace).toBeVisible();

  await revealAction(deepSeek, "uninstall-package");
  await press(action(deepSeek, "uninstall-package"));
  await expect.poll(() => spokenText(deepSeek)).toContain("Not installed");
  await capture(page, testInfo, "marketplace-deepseek-removed.png");

  await press(sem(page, "right-panel-close"));
  await expect(sem(page, "shell-conversation")).toBeVisible();
  await sendMessage(page, "Reply once after the Plugin was removed.", {
    replies: 1,
  });
  await capture(page, testInfo, "marketplace-fresh-conversation.png");
});

test.describe("phone Marketplace", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("keeps Connectors as the default tab and exposes Plugins", async ({
    page,
    userId,
  }, testInfo) => {
    await openApplication(page, userId);
    await openBotList(page);
    await openConnectors(page);
    await expect(sem(page, "connections-document")).toBeVisible();
    await capture(page, testInfo, "marketplace-phone-connectors.png");
    await press(sem(page, "marketplace-plugins-tab"));
    await settle(page);
    await expect(sem(page, "marketplace-plugins-document")).toBeVisible();
    await expect(group(page, "DeepSeek")).toBeVisible();
    await capture(page, testInfo, "marketplace-phone-plugins.png");
  });
});
