import type { Locator, Page } from "@playwright/test";
import {
  closeOverlay,
  expect,
  field,
  openApplication,
  openProfileMenu,
  sem,
  test,
} from "./fixtures.ts";

/**
 * Press a named widget.
 *
 * A `Semantics(identifier:)` around a widget that lays itself out — a view
 * action's `Align`, a `Card`'s `ListTile` — reaches the accessibility tree as
 * a container with `pointer-events: none`, and the node that takes the tap is
 * its child. Clicking the identifier itself would land on the canvas behind
 * it, so this presses whichever of the two the engine made tappable.
 */
function tap(scope: Page | Locator, identifier: string) {
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
 * then lands on whatever is passing under the pointer. Waiting out the
 * transition is the only answer available from outside the engine.
 */
async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(700);
}

/**
 * A live region's words.
 *
 * A `Semantics(liveRegion:)` wraps the text it announces rather than being it,
 * so the sentence reaches the accessibility tree as that node's accessible
 * name and not as text a reader could select.
 */
function announcement(page: Page, text: string) {
  return page.locator(`[aria-label="${text}"]`);
}

/**
 * Open account Settings, and be sure that is where it landed.
 *
 * Every entry of the profile sheet opens a surface that calls itself a
 * settings document, so the marker is the one card only the account's own
 * Settings draws; a press that missed is retried from the conversation.
 */
async function openSettings(page: Page): Promise<void> {
  await expect(async () => {
    if (
      !(await sem(page, "sidebar-profile")
        .isVisible()
        .catch(() => false))
    ) {
      await page.goBack();
    }
    await openProfileMenu(page);
    await settle(page);
    await tap(page, "profile-settings").click();
    await expect(sem(page, "settings-document")).toBeVisible({
      timeout: 20_000,
    });
  }).toPass({ timeout: 120_000 });
  await settle(page);
}

test("a User edits and saves the prefilled profile name", async ({
  page,
  userId,
}) => {
  await openApplication(page, userId);
  await openSettings(page);

  const settings = sem(page, "settings-document");
  const name = field(settings, "view-field-f0.name");
  // A Flutter text field keeps its value on the canvas and only mirrors it
  // into the nested `<input>` while that input is the focused editor, so the
  // value is read after a click rather than off the painted field.
  await name.click();
  await expect(name).toHaveValue("Local developer");
  await name.fill("Tim");

  // Every projected section carries its own Save. The profile's is the one
  // that names what it saves, so there is exactly one button on this surface
  // that means "save what I just typed here".
  await expect(settings.getByText("Save profile")).toHaveCount(1);
  await tap(settings, "view-action-save-0").click();
  await expect(announcement(page, "Saved.")).toBeVisible({ timeout: 60_000 });

  // The name a person chose is the name the account is signed in under.
  await closeOverlay(page);
  await openProfileMenu(page);
  await expect(sem(page, "profile-name")).toContainText("Tim");
});
