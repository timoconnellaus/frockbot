// Hiding a Bot from the sidebar turns its notifications off, in the client a
// person actually presses. The transaction that enforces the pair is covered
// through the gateway; what only the real app can show is the confirmation
// that appears before the pair changes, the switch drawn off and disabled
// while the Bot is hidden, and what showing the Bot again does not do.
import type { Locator, Page, TestInfo } from "@playwright/test";
import {
  commitAndLoseTheAnswer,
  createBot,
  expect,
  openApplication,
  sem,
  settle,
  test,
  openBotSettings,
} from "./fixtures.ts";

/** Press a named widget: the identifier's node, or the child that takes taps. */
function tap(scope: Page | Locator, identifier: string): Locator {
  const node = `[flt-semantics-identifier="${identifier}"]`;
  return scope.locator(`${node}[flt-tappable], ${node} [flt-tappable]`).first();
}

/**
 * A named switch. The identifier is the switch's own, so it is the same node
 * whether or not the row around it can be pressed.
 */
function toggle(page: Page, identifier: string): Locator {
  return sem(page, identifier).first();
}

/** A named screenshot, kept with the run so a reviewer can see the surface. */
async function shot(
  page: Page,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

/** Every ordinary sidebar row, by the name it shows. */
function row(page: Page, name: string): Locator {
  return sem(page, "shell-sidebar")
    .locator('[flt-semantics-identifier^="sidebar-bot-"]')
    .filter({ hasText: name });
}

// Tall enough that the whole Settings page is on screen: a canvas has nothing
// for Playwright to scroll into view.
test.use({ viewport: { width: 1280, height: 1024 } });

test("hiding a Bot asks first, turns notifications off with it, and leaves them off", async ({
  page,
  userId,
}, testInfo) => {
  await page.context().grantPermissions(["notifications"]);
  await openApplication(page, userId);
  await createBot(page, "Quiet");
  await settle(page);
  await openBotSettings(page);

  const notifications = toggle(page, "bot-notifications");
  const hidden = toggle(page, "bot-hidden-from-sidebar");
  // This spec is about hiding a Bot that notifies, so it starts from one.
  if ((await notifications.getAttribute("aria-checked")) !== "true") {
    await notifications.click();
  }
  await expect(notifications).toHaveAttribute("aria-checked", "true");

  await settle(page);
  await expect(hidden).toHaveAttribute("aria-checked", "false");

  // 1. The confirmation says what hiding will do to notifications.
  await hidden.click();
  const dialog = sem(page, "bot-hide-confirm");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("also turns off its notifications");
  await shot(page, testInfo, "confirmation");

  // 2. Cancel changes neither switch, and the Bot stays in the list.
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
  await settle(page);
  await expect(hidden).toHaveAttribute("aria-checked", "false");
  await expect(notifications).toHaveAttribute("aria-checked", "true");
  await expect(row(page, "Quiet")).toHaveCount(1);

  // 3. Confirming draws both switches at once, and the Bot leaves the list.
  await hidden.click();
  await expect(dialog).toBeVisible();
  await page
    .getByRole("button", { name: "Hide and turn off", exact: true })
    .click();
  await expect(hidden).toHaveAttribute("aria-checked", "true");
  await expect(notifications).toHaveAttribute("aria-checked", "false");
  await expect(row(page, "Quiet")).toHaveCount(0);

  // 4. While hidden the switch is disabled and says why, and pressing it does
  //    nothing — there is no tappable node under it to press.
  await expect(notifications).toHaveAttribute(
    "aria-label",
    /Off while this Bot is hidden from the sidebar/u,
  );
  await expect(tap(page, "bot-notifications")).toHaveCount(0);
  await notifications.click({ force: true });
  await settle(page);
  await expect(notifications).toHaveAttribute("aria-checked", "false");
  await shot(page, testInfo, "hidden-and-muted");

  // 5. The pair is durable, not a view: the page is booted again and the Bot —
  //    now behind the sidebar's hidden entry — reads back hidden and muted.
  await page.reload();
  await expect(sem(page, "shell-sidebar")).toBeVisible({ timeout: 120_000 });
  await settle(page);
  await tap(page, "sidebar-hidden-toggle").click();
  await settle(page);
  await row(page, "Quiet").click();
  await settle(page);
  await openBotSettings(page);
  await expect(toggle(page, "bot-notifications")).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await settle(page);
  await expect(toggle(page, "bot-hidden-from-sidebar")).toHaveAttribute(
    "aria-checked",
    "true",
  );

  // 6. Showing the Bot again leaves notifications off until they are asked
  //    for, and then they can be asked for.
  await toggle(page, "bot-hidden-from-sidebar").click();
  await expect(toggle(page, "bot-hidden-from-sidebar")).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await expect(toggle(page, "bot-notifications")).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await shot(page, testInfo, "shown-again-still-muted");

  // 7. And a Bot that is already muted has nothing to warn about: hiding it
  //    asks nothing and applies straight away.
  await toggle(page, "bot-hidden-from-sidebar").click();
  await expect(sem(page, "bot-hide-confirm")).toHaveCount(0);
  await expect(toggle(page, "bot-hidden-from-sidebar")).toHaveAttribute(
    "aria-checked",
    "true",
  );
});

test.describe("a hide whose answer never arrives", () => {
  // The save below is committed and then cut off on purpose, so the client's
  // own failure handling is what the case is about.
  test.use({
    allowedFailures: {
      console: [/Failed to load resource/u, /net::ERR_FAILED/u],
      requests: [/\/api\/bots\/[^/]+\/settings:/u],
    },
  });

  test("settles on what the authority holds rather than on what the client guessed", async ({
    page,
    userId,
  }, testInfo) => {
    await page.context().grantPermissions(["notifications"]);
    await openApplication(page, userId);
    await createBot(page, "Lost");
    await settle(page);
    await openBotSettings(page);

    const notifications = toggle(page, "bot-notifications");
    const hidden = toggle(page, "bot-hidden-from-sidebar");
    if ((await notifications.getAttribute("aria-checked")) !== "true") {
      await notifications.click();
    }
    await expect(notifications).toHaveAttribute("aria-checked", "true");
    await settle(page);

    // A flaky connection that drops the answer after the Worker committed it:
    // the request really is served, and the client never hears how it went.
    let served: () => void = () => {};
    const theSaveWasServed = new Promise<void>((resolve) => {
      served = resolve;
    });
    await page.route("**/api/bots/*/settings", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      try {
        await commitAndLoseTheAnswer(route);
      } finally {
        served();
      }
    });
    await hidden.click();
    await page
      .getByRole("button", { name: "Hide and turn off", exact: true })
      .click();
    await expect(sem(page, "bot-settings-status")).toContainText(/./u);
    // The handler is finished before the case moves on, so nothing is still
    // holding the save when the reload below cancels the page's requests.
    await theSaveWasServed;
    await page.unroute("**/api/bots/*/settings");
    await settle(page);

    // The authority hid and muted the Bot, so that — not the client's older
    // belief that it was visible and notifying — is what the surface shows,
    // and the sidebar agrees.
    await expect(hidden).toHaveAttribute("aria-checked", "true");
    await expect(notifications).toHaveAttribute("aria-checked", "false");
    await expect(row(page, "Lost")).toHaveCount(0);
    await shot(page, testInfo, "lost-answer-reconciled");

    // And it is the authority's state, not a repaint: a fresh boot reads the
    // same pair back.
    await page.reload();
    await expect(sem(page, "shell-sidebar")).toBeVisible({ timeout: 120_000 });
    await settle(page);
    await tap(page, "sidebar-hidden-toggle").click();
    await settle(page);
    await row(page, "Lost").click();
    await settle(page);
    await openBotSettings(page);
    await expect(toggle(page, "bot-notifications")).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });
});
