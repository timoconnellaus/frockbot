import { expect, test } from "./fixtures.ts";
import { firstRunDialog, openApplication } from "./fixtures.ts";

/**
 * Send the first-run dialog away. This User owns no Bot — it never creates
 * one — so the dialog and its backdrop come back on every load, and the
 * backdrop swallows the clicks the profile menu needs.
 */
async function dismissFirstRun(page: Parameters<typeof openApplication>[0]) {
  const firstRun = firstRunDialog(page);
  if (!(await firstRun.isVisible().catch(() => false))) return;
  await firstRun.getByRole("button", { name: "Cancel" }).click();
  await expect(firstRun).toBeHidden();
  await expect(page.locator(".flock-backdrop")).toHaveCount(0);
}

/**
 * Two states have to converge, the way `createBot` converges them: the dialog
 * may not have opened yet when the profile menu is clicked, and its backdrop
 * swallows that click the moment it does. Retrying the whole approach settles
 * whichever order the shell arrives in.
 */
async function openAdmin(page: Parameters<typeof openApplication>[0]) {
  await expect(async () => {
    await dismissFirstRun(page);
    await page
      .getByRole("button", { name: "FrockBot user" })
      .click({ timeout: 2_000 });
    await page
      .getByRole("menuitem", { name: "Admin" })
      .click({ timeout: 2_000 });
    await expect(page.getByRole("heading", { name: "Admin" })).toBeVisible({
      timeout: 2_000,
    });
  }).toPass({ timeout: 60_000 });
}

test("an admin changes the durable signup policy", async ({ page }) => {
  await openApplication(page, "development");
  await openAdmin(page);

  const toggle = page.getByLabel("Accept new signups");
  await expect(toggle).toBeEnabled();
  const initial = await toggle.isChecked();
  await toggle.click();
  await expect(toggle).toBeChecked({ checked: !initial });

  await page.reload();
  await expect(
    page.getByRole("button", { name: "Plugins", exact: true }),
  ).toBeVisible();
  await openAdmin(page);
  await expect(page.getByLabel("Accept new signups")).toBeChecked({
    checked: !initial,
  });
});
