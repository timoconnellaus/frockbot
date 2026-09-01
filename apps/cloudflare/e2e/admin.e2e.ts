import { expect, test } from "./fixtures.ts";
import { firstRunDialog, openApplication } from "./fixtures.ts";

async function openAdmin(page: Parameters<typeof openApplication>[0]) {
  await page.getByRole("button", { name: "FrockBot user" }).click();
  await page.getByRole("menuitem", { name: "Admin" }).click();
  await expect(page.getByRole("heading", { name: "Admin" })).toBeVisible();
}

test("an admin changes the durable signup policy", async ({ page }) => {
  await openApplication(page, "development");
  const firstRun = firstRunDialog(page);
  if (await firstRun.isVisible().catch(() => false)) {
    await firstRun.getByRole("button", { name: "Cancel" }).click();
  }
  await openAdmin(page);

  const toggle = page.getByLabel("Accept new signups");
  await expect(toggle).toBeEnabled();
  const initial = await toggle.isChecked();
  await toggle.click();
  await expect(toggle).toBeChecked({ checked: !initial });

  await page.reload();
  await openAdmin(page);
  await expect(page.getByLabel("Accept new signups")).toBeChecked({
    checked: !initial,
  });
});
