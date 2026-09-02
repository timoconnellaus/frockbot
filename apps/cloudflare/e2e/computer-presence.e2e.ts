// The sidebar Computer strip (plan docs/plans/computer-presence.md, P1–P2):
// it mounts in the shell's sidebar, wakes nothing by being visible, and its
// first click expands rather than takes over. The harness runs without a
// Computer host, so the strip renders the unconfigured phase; what this proves
// is the shell slot, the Package mount, and that the strip and the expanded
// viewer compose without a console or request error (the page fixture fails
// on either).
import { test, expect, provisionThroughUi, revealSidebar } from "./fixtures.ts";
import { E2E_OLLAMA_GOOD_API_KEY } from "./harness.ts";

test("the sidebar strip shows the Computer and expands on first click", async ({
  page,
  userId,
  ollamaBaseUrl,
}) => {
  await page.setViewportSize({ width: 1351, height: 859 });
  await provisionThroughUi(page, {
    userId,
    apiKey: E2E_OLLAMA_GOOD_API_KEY,
    apiBaseUrl: ollamaBaseUrl,
    botName: "Watched",
  });

  const strip = page.getByRole("button", { name: /^Open Computer/ });
  await expect(strip).toBeVisible();
  await expect(strip).toHaveAttribute("aria-label", /unconfigured/);
  await page.screenshot({
    path: "e2e/test-results/computer-presence-desktop.png",
  });

  // One click expands; nothing in the harness can wake, so no command that
  // would reach a Computer host is issued and the fixture sees no 5xx.
  await strip.click();
  const overlay = page.locator(".computer-overlay");
  await expect(overlay.first()).toBeVisible();
  await page.screenshot({
    path: "e2e/test-results/computer-presence-expanded.png",
  });
  await page.keyboard.press("Escape");
  await expect(overlay.first()).toBeHidden();

  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test("the sidebar strip fits the mobile shell", async ({
  page,
  userId,
  ollamaBaseUrl,
}) => {
  await provisionThroughUi(page, {
    userId,
    apiKey: E2E_OLLAMA_GOOD_API_KEY,
    apiBaseUrl: ollamaBaseUrl,
    botName: "Pocket",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await revealSidebar(page);
  const strip = page.getByRole("button", { name: /^Open Computer/ });
  await expect(strip).toBeVisible();
  await page.screenshot({
    path: "e2e/test-results/computer-presence-mobile.png",
  });
});
