import { test, expect, openApplication, firstRunDialog } from "./fixtures.ts";

test("Gmail is a direct searchable connector with durable connected and disconnected states", async ({
  page,
  userId,
}) => {
  test.setTimeout(60_000);
  await page.route("https://connect.example.test/**", async (route) => {
    const callback = new URL(route.request().url()).searchParams.get(
      "callback",
    );
    if (!callback) throw new Error("Fake authorization needs its callback");
    await route.fulfill({ status: 302, headers: { location: callback } });
  });
  await openApplication(page, userId);
  await firstRunDialog(page).getByRole("button", { name: "Cancel" }).click();
  // Follow the same single-surface navigation as a User.
  await page.locator("button.profile-trigger").click();
  await page.getByRole("menuitem", { name: "Connectors", exact: true }).click();
  await page.getByRole("searchbox").fill("gmail");
  const card = page
    .locator(".connector-card")
    .filter({ has: page.getByText("Gmail", { exact: true }) });
  await expect(card).toHaveCount(1);
  await expect(
    card.getByRole("button", { name: "Connect", exact: true }),
  ).toBeVisible();
  await card.getByRole("button", { name: "Connect", exact: true }).click();
  await card
    .getByRole("textbox", { name: "Account label" })
    .fill("tim@example.com");
  await card.getByRole("button", { name: "Continue to sign in" }).click();
  await page.waitForURL(/connection=composio-ready/, { timeout: 30_000 });
  await firstRunDialog(page).getByRole("button", { name: "Cancel" }).click();
  await page.locator("button.profile-trigger").click();
  await page.getByRole("menuitem", { name: "Connectors", exact: true }).click();
  await page.getByRole("searchbox").fill("gmail");
  await expect(
    card.getByText("Connected as tim@example.com", { exact: true }),
  ).toBeVisible();
  await expect(card).not.toContainText("Composio");
  await page.screenshot({
    path: "e2e/test-results/gmail-connected.png",
    fullPage: true,
    animations: "disabled",
  });
  await card.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(
    card.getByText("Connected as tim@example.com", { exact: true }),
  ).toHaveCount(0);
  await expect(
    card.getByRole("button", { name: "Connect", exact: true }),
  ).toBeVisible();
});
