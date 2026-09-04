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
    await page.locator("button.profile-trigger").click({ timeout: 2_000 });
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
  await expect(page.locator("button.profile-trigger")).toHaveText(
    "Local developer",
  );
  await openAdmin(page);

  const toggle = page.getByLabel("Accept new signups");
  await expect(toggle).toBeEnabled();
  const initial = await toggle.isChecked();
  // The same convergence `openAdmin` needs, for the same reason: this User owns
  // no Bot, so the first-run dialog can arrive after the Admin page has opened
  // and its backdrop then swallows this click — on a loaded CI runner it did,
  // for the whole four-minute budget. Dismissing it and retrying the approach
  // settles whichever order the shell arrives in; the subject of this test is
  // the durable policy, not the dialog's timing.
  //
  // The click is guarded by the toggle's own reading rather than issued every
  // attempt, because a retry that clicked again would toggle the policy back
  // and the assertion would oscillate instead of settling.
  await expect(async () => {
    await dismissFirstRun(page);
    if ((await toggle.isChecked()) === initial) {
      await toggle.click({ timeout: 2_000 });
    }
    await expect(toggle).toBeChecked({ checked: !initial, timeout: 2_000 });
  }).toPass({ timeout: 60_000 });

  await page.reload();
  await expect(
    page.getByRole("button", { name: "Connectors", exact: true }),
  ).toBeVisible();
  await openAdmin(page);
  await expect(page.getByLabel("Accept new signups")).toBeChecked({
    checked: !initial,
  });
});
