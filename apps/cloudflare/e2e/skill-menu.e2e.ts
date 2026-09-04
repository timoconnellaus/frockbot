// The composer's Skill popover, driven from the keyboard.
//
// Typing `/` opens it, and on production the arrow keys did nothing: the
// highlight moved on `keydown` and the same key's `keyup` refreshed the popover,
// which reset the highlight to the first row. Every Bot sees the managed Skills
// with no seeding at all, so this spec needs nothing but a provisioned Bot and
// the keyboard.
import { test, expect, composerInput, provisionThroughUi } from "./fixtures.ts";
import { E2E_OLLAMA_GOOD_API_KEY } from "./harness.ts";

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
  await composer.click();
  await composer.pressSequentially("/");

  const popover = page.locator("#skill-popover");
  const options = popover.getByRole("option");
  await expect(popover).toBeVisible();
  // Three rows are what this spec navigates; the managed set is larger.
  const count = await options.count();
  expect(count).toBeGreaterThanOrEqual(3);
  const third = await options.nth(2).locator(".skill-option-name").innerText();

  // The first row is highlighted on open, so two presses land on the third.
  await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");
  await composer.press("ArrowDown");
  await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
  await composer.press("ArrowDown");
  await expect(options.nth(2)).toHaveAttribute("aria-selected", "true");
  // The regression: the highlight snapped back to row zero between presses.
  await expect(options.nth(0)).toHaveAttribute("aria-selected", "false");

  // ArrowUp wraps off the top and ArrowDown brings it back round.
  await composer.press("ArrowUp");
  await composer.press("ArrowUp");
  await composer.press("ArrowUp");
  await expect(options.nth(count - 1)).toHaveAttribute("aria-selected", "true");
  await composer.press("ArrowDown");
  await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");
  await composer.press("ArrowDown");
  await composer.press("ArrowDown");
  await expect(options.nth(2)).toHaveAttribute("aria-selected", "true");

  await composer.press("Enter");
  // Enter attaches the highlighted Skill as a chip and takes the trigger back
  // out of the message; it does not send the Turn.
  await expect(popover).toBeHidden();
  await expect(page.locator(".skill-chip-name")).toHaveText(third);
  await expect(composer).toHaveValue("");

  // Escape closes the popover and leaves what was typed alone.
  await composer.click();
  await composer.pressSequentially("/");
  await expect(popover).toBeVisible();
  await composer.press("Escape");
  await expect(popover).toBeHidden();
  await expect(composer).toHaveValue("/");
});
