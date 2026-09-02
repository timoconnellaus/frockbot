// A first configuration read and first Bot creation leave durable Package
// installations behind. This browser layer proves those records reach the
// User-facing projection without a setup detour or a second grant surface.
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

  // Unanchored: the strip leads with a status badge, so its text carries
  // whitespace either side of the count.
  await expect(page.getByText(/\d+ installed/u)).toBeVisible();
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
    // Plugins says whether a Package is on and nothing else: no Connect
    // control appears here even for a Package that has accounts elsewhere.
    await expect(card).toContainText("Enabled");
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

  // The retired Bot info pane's contents live in Bot settings now: the
  // notifications switch on the front of it, the model setting under Advanced.
  await page.getByRole("button", { name: "Close panel" }).click();
  // Exact: the Catalog behind this panel lists a "FrockBot Settings" Package.
  await page.getByRole("button", { name: "Bot settings", exact: true }).click();
  const pane = page.getByRole("region", { name: "Settings" });
  await expect(
    pane.locator("#bot-info-notifications").getByRole("checkbox"),
  ).toBeChecked();
  await pane.getByText("Advanced").click();
  await expect(pane.getByText("Model", { exact: true })).toBeVisible();
  await expect(pane.getByText("Capability Assignments")).toHaveCount(0);
});
