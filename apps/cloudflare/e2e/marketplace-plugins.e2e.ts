import type { Page, TestInfo } from "@playwright/test";
import {
  expect,
  group,
  closeOverlay,
  openApplication,
  openConnectors,
  openModels,
  press,
  revealSidebar,
  sem,
  sendMessage,
  settle,
  test,
} from "./fixtures.ts";

async function capture(
  page: Page,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  const path = testInfo.outputPath(name);
  await page.screenshot({ path });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

async function openBotList(page: Page): Promise<void> {
  await expect(async () => {
    await revealSidebar(page);
    await expect(sem(page, "sidebar-marketplace")).toBeVisible({
      timeout: 1_000,
    });
  }).toPass({ timeout: 120_000 });
  await settle(page);
}

async function searchMarketplace(page: Page, query: string): Promise<void> {
  const search = sem(page, "marketplace-search").locator("input, textarea");
  await expect(search.first()).toBeVisible();
  await search.first().fill(query);
  await settle(page);
}

test("Marketplace installs a model and leaves a fresh Bot usable", async ({
  page,
  userId,
}, testInfo) => {
  await openApplication(page, userId);
  await openBotList(page);

  await openConnectors(page);
  await expect(sem(page, "marketplace-search")).toBeVisible();
  await expect(sem(page, "marketplace-filter")).toBeVisible();
  await capture(page, testInfo, "marketplace-catalog.png");

  await searchMarketplace(page, "DeepSeek");
  const deepSeek = group(page, "DeepSeek");
  await expect(deepSeek).toBeVisible();
  await capture(page, testInfo, "marketplace-deepseek-not-installed.png");

  await press(sem(deepSeek, "view-action-add-provider-deepseek"));
  await expect(deepSeek.getByText("Connect", { exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await capture(page, testInfo, "marketplace-deepseek-installed.png");

  await press(sem(page, "right-panel-close"));
  await expect(sem(page, "shell-conversation")).toBeVisible();
  await openModels(page);
  await expect(group(page, "DeepSeek")).toBeVisible();
  await capture(page, testInfo, "marketplace-deepseek-model-setup.png");

  await closeOverlay(page);
  await sendMessage(page, "Reply once after the model was added.", {
    replies: 1,
  });
  await capture(page, testInfo, "marketplace-fresh-conversation.png");
});

test.describe("phone Marketplace", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("is one searchable catalog on a phone", async ({
    page,
    userId,
  }, testInfo) => {
    await openApplication(page, userId);
    await openBotList(page);
    await openConnectors(page);
    await expect(sem(page, "connections-document")).toBeVisible();
    await expect(sem(page, "marketplace-search")).toBeVisible();
    await capture(page, testInfo, "marketplace-phone-catalog.png");
    await searchMarketplace(page, "DeepSeek");
    await expect(group(page, "DeepSeek")).toBeVisible();
    await capture(page, testInfo, "marketplace-phone-deepseek.png");
  });
});
