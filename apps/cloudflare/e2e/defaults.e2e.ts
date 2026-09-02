// The platform model makes the first Bot usable without a setup detour.
import {
  composerInput,
  createBot,
  expect,
  openApplication,
  sendMessage,
  test,
} from "./fixtures.ts";

test("a fresh User's Bot answers with zero configuration and no model prompt", async ({
  page,
  userId,
}) => {
  await openApplication(page, userId);
  await createBot(page, "Ready");

  await expect(
    page.getByRole("button", { name: "Choose a model" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Ready is ready." }),
  ).toBeVisible();
  await expect(composerInput(page)).toBeEnabled();

  await sendMessage(page, "Answer with the platform model");
  await expect(page.locator(".message-assistant").last()).toContainText(
    "Reply from the Workers AI stub.",
  );
});
