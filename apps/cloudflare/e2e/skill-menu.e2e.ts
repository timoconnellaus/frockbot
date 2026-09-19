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
  answerInputs,
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
 * Type the trigger and wait for the popover, the way a person reaches it: tap
 * the composer, then type.
 *
 * Choosing a Skill rewrites the field's value from Dart, and the engine
 * answers a rewrite by tearing its editing element down. `answerInputs`
 * reopens the engine's editing session and proves the widget—not only the DOM
 * element—accepted the slash. The field is focused again after that helper's
 * deliberate blur so the arrow-key assertions exercise the real keyboard
 * path. The gesture must not be retried: once the popover exists, another
 * click can select the option under that point before its semantics node
 * reaches the browser.
 */
async function openPopover(page: Page): Promise<void> {
  const composer = composerInput(page);
  await answerInputs([[composer, "/"]]);
  await sem(page, "chat-composer").click();
  await expect(composer).toBeFocused();
  await expect(sem(page, "skill-menu")).toBeVisible({ timeout: 60_000 });
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
  // Read with the session open: the rewrite closed it, and a Flutter field
  // with no editing element has no value on this side to read at all.
  await sem(page, "chat-composer").click();
  await expect(composerInput(page)).toHaveValue("");

  // Reopening after this Dart-side rewrite is covered directly by
  // `skill_popover_reopen_test.dart`; repeating the whole browser journey here
  // added no integration boundary to the keyboard-navigation claim above.
});
