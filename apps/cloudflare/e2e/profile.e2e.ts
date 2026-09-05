import { expect, firstRunDialog, openApplication, test } from "./fixtures.ts";

test("a User edits and saves the prefilled profile name", async ({
  page,
  userId,
}) => {
  await openApplication(page, userId);
  const firstRun = firstRunDialog(page);
  await expect(firstRun).toBeVisible();
  await firstRun.getByRole("button", { name: "Cancel" }).click();
  await expect(firstRun).toBeHidden();

  const profileTrigger = page.locator("button.profile-trigger");
  await expect(profileTrigger).toHaveText("Local developer");
  await profileTrigger.click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();

  const settings = page.getByRole("region", {
    name: "Settings",
  });
  const name = settings.getByLabel("Name");
  await expect(name).toHaveValue("Local developer");
  await name.fill("Tim");
  // Package settings sections carry their own Save. The profile's sits with
  // the two fields it saves and names them, so there is exactly one button on
  // this surface that means "save what I just typed here".
  await expect(
    settings.getByRole("button", { name: "Save profile" }),
  ).toHaveCount(1);
  await settings.getByRole("button", { name: "Save profile" }).click();

  await expect(settings).toBeHidden();
  await expect(profileTrigger).toHaveText("Tim");
});
