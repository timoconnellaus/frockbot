// The composer's Skill popover, driven from the keyboard.
//
// Typing `/` opens it, and on production the arrow keys did nothing: the
// highlight moved on `keydown` and the same key's `keyup` refreshed the
// popover, which reset the highlight to the first row. Every Bot sees the
// managed Skills with no seeding at all, so this spec needs nothing but a
// provisioned Bot and the keyboard.
import {
  test,
  expect,
  composerInput,
  provisionThroughUi,
  sem,
} from "./fixtures.ts";
import { E2E_OLLAMA_GOOD_API_KEY } from "./harness.ts";
import type { Locator, Page } from "@playwright/test";

/** Whether a row is the highlighted one, as the engine reports a list's choice. */
async function expectHighlighted(
  option: Locator,
  highlighted: boolean,
): Promise<void> {
  await expect(option).toHaveAttribute(
    "aria-current",
    highlighted ? "true" : "false",
  );
}

/**
 * Type the trigger and wait for the popover.
 *
 * Retried as a whole because a keystroke aimed at a Flutter text field only
 * lands while the engine holds an editing session open on it, and choosing a
 * Skill rewrites the field's value from Dart — which closes the session and
 * builds a new element under the one this side just clicked. The retry types
 * into whatever is there now.
 */
async function openPopover(page: Page): Promise<void> {
  const composer = composerInput(page);
  await expect(async () => {
    // Focused and typed rather than clicked and filled. `fill` writes the
    // element's value, which the engine reads only while it is holding an
    // editing session open on that field — and choosing a Skill rewrites the
    // field from Dart, which ends the session and builds a new element under
    // the one this side just clicked. So the trigger was landing in the DOM,
    // `toHaveValue` was agreeing about it, and the widget never saw a `/` at
    // all: the menu opened the first time and never again. Typing into a
    // focused field always reaches the widget, and select-all is what clears
    // whatever was there without a `fill`.
    await composer.focus();
    await composer.press("ControlOrMeta+a");
    await composer.pressSequentially("/");
    await expect(composer).toHaveValue("/");
    await expect(sem(page, "skill-menu")).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 60_000 });
}

test("the Skill popover keeps the highlight the arrow keys put on it", async ({
  page,
  userId,
  ollamaBaseUrl,
}) => {
  await provisionThroughUi(page, {
    userId,
    apiKey: E2E_OLLAMA_GOOD_API_KEY,
    apiBaseUrl: ollamaBaseUrl,
    botName: "Picker",
  });

  const composer = composerInput(page);
  await openPopover(page);

  const popover = sem(page, "skill-menu");
  const options = popover.locator(
    '[flt-semantics-identifier^="skill-option-"]',
  );
  await expect(popover).toBeVisible();
  // Three rows are what this spec navigates; the managed set is larger.
  const count = await options.count();
  expect(count).toBeGreaterThanOrEqual(3);
  // Named by the ref the catalog gave it, which is what the chip carries too:
  // a row's node text is its name, its description and its ref run together,
  // and the chip shows only the name.
  const third = (
    (await options.nth(2).getAttribute("flt-semantics-identifier")) ?? ""
  ).replace("skill-option-", "");
  expect(third).not.toBe("");

  // The first row is highlighted on open, so two presses land on the third.
  await expectHighlighted(options.nth(0), true);
  await composer.press("ArrowDown");
  await expectHighlighted(options.nth(1), true);
  await composer.press("ArrowDown");
  await expectHighlighted(options.nth(2), true);
  // The regression: the highlight snapped back to row zero between presses.
  await expectHighlighted(options.nth(0), false);

  // ArrowUp wraps off the top and ArrowDown brings it back round.
  await composer.press("ArrowUp");
  await composer.press("ArrowUp");
  await composer.press("ArrowUp");
  await expectHighlighted(options.nth(count - 1), true);
  await composer.press("ArrowDown");
  await expectHighlighted(options.nth(0), true);
  await composer.press("ArrowDown");
  await composer.press("ArrowDown");
  await expectHighlighted(options.nth(2), true);

  // Choosing attaches the Skill as a chip and takes the trigger back out of
  // the message; it does not send the Turn. The choice is a press rather than
  // Enter: this client binds the arrows and Escape while the popover is open
  // and leaves Enter to the multi-line field it is drawn over.
  await options.nth(2).click();
  await expect(popover).toBeHidden();
  await expect(
    sem(sem(page, "skill-chips"), `skill-chip-${third}`),
  ).toBeVisible();
  await expect(composer).toHaveValue("");

  // Escape closes the popover and leaves what was typed alone.
  await openPopover(page);
  await composer.press("Escape");
  await expect(popover).toBeHidden();
  await expect(composer).toHaveValue("/");
});
