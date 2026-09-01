// A first configuration read and first Bot creation must leave durable Package
// installations and Capability Assignments behind. This browser layer proves
// those records reach both User-facing projections without a setup detour.
import {
  createBot,
  expect,
  openApplication,
  openPlugins,
  test,
} from "./fixtures.ts";

test("a fresh User and Bot start with first-party capabilities", async ({
  page,
  userId,
}) => {
  await openApplication(page, userId);
  await createBot(page, "Equipped");
  await openPlugins(page);

  await expect(page.getByText(/^\d+ installed$/u)).toBeVisible();
  for (const displayName of [
    "Bot templates",
    "Flock",
    "Image generation",
    "Messages on your Mac",
    "Registered machines",
    "Routines",
    "Subagents",
    "Web",
  ]) {
    const card = page.locator("article.plugin-card", {
      has: page.getByText(displayName, { exact: true }),
    });
    await expect(card).toContainText("Added");
    await expect(
      card.getByRole("button", { name: "Connect", exact: true }),
    ).toHaveCount(0);
  }

  await page
    .getByRole("button", { name: "Browse the Package Catalog" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Package Catalog" }),
  ).toBeVisible();
  await expect(page.getByLabel("Search the Package Catalog")).toBeVisible();

  await page.getByRole("button", { name: "Close panel" }).click();
  await page.getByRole("button", { name: "Bot info" }).click();
  const pane = page.getByRole("region", { name: "Bot info" });
  await expect(
    pane.locator("#bot-info-notifications").getByRole("checkbox"),
  ).toBeChecked();
  await expect(
    pane.getByText("Web · web-fetch", { exact: true }),
  ).toBeVisible();
  await expect(
    pane.getByText("Routines · routine-tools", { exact: true }),
  ).toBeVisible();
});
