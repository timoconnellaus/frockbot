import type { Page } from "@playwright/test";
import {
  expect,
  openApplication,
  openProfileMenu,
  sem,
  SHELL_TIMEOUT_MS,
  test,
} from "./fixtures.ts";

/**
 * Press a named widget.
 *
 * A `Semantics(identifier:)` around a widget that lays itself out — a
 * `ListTile` in a `Card`, a `SwitchListTile` — reaches the accessibility tree
 * as a container with `pointer-events: none`, and the node that takes the tap
 * is its child. Clicking the identifier itself would land on the canvas behind
 * it, so this presses whichever of the two the engine made tappable.
 */
function tap(scope: Page, identifier: string) {
  const node = `[flt-semantics-identifier="${identifier}"]`;
  return scope.locator(`${node}[flt-tappable], ${node} [flt-tappable]`).first();
}

/**
 * Let a surface finish arriving before pressing anything on it.
 *
 * Flutter rebuilds the accessibility tree when semantics change rather than
 * once a frame, so a sliding sheet or a pushed page reaches the DOM at its
 * final position while the canvas is still moving — and Playwright's own
 * stability check, which watches that DOM box, sees nothing to wait for. The
 * engine hit-tests a press against the frame it is painting, so a press issued
 * then lands on whatever is passing under the pointer.
 */
async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(700);
}

/**
 * Admin belongs to the deployment rather than to the account, so its entry is
 * in the profile sheet only for someone the gateway already answers it for.
 */
async function openAdmin(page: Page) {
  await openProfileMenu(page);
  await settle(page);
  await tap(page, "profile-admin").click();
  await expect(sem(page, "admin-signups")).toBeVisible({
    timeout: SHELL_TIMEOUT_MS,
  });
}

/** The switch itself, which is the child node of the named row. */
function signups(page: Page) {
  return sem(page, "admin-signups").locator('[role="switch"]');
}

test("an admin changes the durable signup policy", async ({ page }) => {
  // `development` is the one identity this deployment treats as an admin, so
  // this test does not take a fresh `userId` the way every other one does.
  await openApplication(page, "development");
  await openProfileMenu(page);
  await expect(sem(page, "profile-name")).toContainText("Local developer");
  await settle(page);
  await tap(page, "profile-admin").click();
  await expect(sem(page, "admin-signups")).toBeVisible({
    timeout: SHELL_TIMEOUT_MS,
  });
  await settle(page);

  await expect(signups(page)).toBeEnabled();
  const initial = await signups(page).getAttribute("aria-checked");
  const flipped = initial === "true" ? "false" : "true";
  await signups(page).click();
  await expect(signups(page)).toHaveAttribute("aria-checked", flipped);

  // The policy is the deployment's, not this session's: a reload reads it back
  // from the authority rather than from anything the page was holding.
  await page.reload();
  await expect(
    sem(page, "shell-sidebar").or(sem(page, "sidebar-toggle")),
  ).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  await openAdmin(page);
  await settle(page);
  await expect(signups(page)).toHaveAttribute("aria-checked", flipped);
});
