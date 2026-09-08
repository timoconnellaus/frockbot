import { test, expect, provisionThroughUi, sendMessage } from "./fixtures.ts";
import { E2E_OLLAMA_GOOD_API_KEY } from "./harness.ts";

for (const reload of [false, true]) {
  test(`one chat retains both Turns${reload ? " after reload" : ""}`, async ({
    page,
    userId,
    ollamaBaseUrl,
  }) => {
    await provisionThroughUi(page, {
      userId,
      apiKey: E2E_OLLAMA_GOOD_API_KEY,
      apiBaseUrl: ollamaBaseUrl,
      botName: "Rememberer",
    });
    await sendMessage(page, "Remember the first message");
    if (reload) await page.reload();
    await sendMessage(page, "And the second message");
    await expect(
      page
        .locator("main")
        .getByText("Remember the first message", { exact: true }),
    ).toBeVisible();
    await expect(
      page.locator("main").getByText("And the second message", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "New conversation", exact: true }),
    ).toHaveCount(0);
  });
}
