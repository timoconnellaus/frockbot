import type { Page, TestInfo } from "@playwright/test";
import {
  answerInputs,
  expect,
  group,
  closeOverlay,
  openApplication,
  openConnectors,
  press,
  revealSidebar,
  searchMarketplace,
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
  // The key is the next thing asked for, so Add leaves its form open.
  const key = deepSeek.locator('input[aria-label="API key"]');
  await expect(key).toBeVisible();
  await capture(page, testInfo, "marketplace-deepseek-installed.png");

  // A saved key is not checked by a paid call, so any key connects; the card
  // then leads on to the one step left, which is choosing the model.
  await answerInputs([[key, "sk-e2e-not-a-real-key"]]);
  await press(deepSeek.getByText("Connect account", { exact: true }));
  const choose = deepSeek.getByText("Choose a model", { exact: true });
  await expect(choose).toBeVisible({ timeout: 60_000 });
  await capture(page, testInfo, "marketplace-deepseek-connected.png");
  await press(choose);
  await expect(sem(page, "settings-model-field")).toBeVisible({
    timeout: 60_000,
  });
  await expect(group(page, "DeepSeek")).toBeVisible();
  await capture(page, testInfo, "marketplace-deepseek-model-setup.png");

  // Back past Models and the Marketplace to the conversation.
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
