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
  // Package settings sections carry their own Save; the profile is saved by
  // the form's own actions row.
  await settings
    .locator("form.settings-form > .settings-actions")
    .getByRole("button", { name: "Save settings" })
    .click();

  await expect(settings).toBeHidden();
  await expect(profileTrigger).toHaveText("Tim");
});
