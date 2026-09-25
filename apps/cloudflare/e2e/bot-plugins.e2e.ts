// The Bot's own Plugins page, driven from its Settings (ADR 0026).
//
// A Bot's Plugins are Bot settings, so the door is the Plugins row in the Bot's
// Settings and the page opens in the panel beside the conversation; there is
// no account-wide Plugins list or feature switchboard. This spec walks the
// product path — check the Profile offers neither, open the page, flip Web off
// — and then reads the same Bot's page back to prove the switch is what the
// Bot serves, not what the widget last painted.
import type { Locator, Page } from "@playwright/test";
import {
  closeOverlay,
  createBot,
  expect,
  openApplication,
  openBotSettings,
  openProfileMenu,
  sem,
  SHELL_TIMEOUT_MS,
  settle,
  tap,
  test,
} from "./fixtures.ts";

/**
 * Prose a widget carries as a label reaches the tree as an `aria-label` on an
 * ancestor rather than as text, so a sentence is looked for either way.
 */
function says(scope: Page | Locator, text: string): Locator {
  return scope
    .getByText(text, { exact: false })
    .or(scope.locator(`[aria-label*="${text}"]`));
}

/**
 * The switch on one Plugin's row.
 *
 * A row's switch reaches the accessibility tree as a `switch` node whose
 * accessible name is the Plugin's name — the kind it belongs to is the label
 * over the group now, rather than a suffix on every row.
 */
function cardSwitch(page: Page, title: string): Locator {
  return page.getByRole("switch", { name: title, exact: true }).first();
}

// Read in a window tall enough to hold every card at once, the way
// `provisionThroughUi` does: a Flutter list publishes semantics only for the
// rows at or near the viewport, and the engine drops a row back out as the list
// moves without reliably putting it back, so scrolling a long list is not
// something to rest assertions on. The height is what this page holds: the
// five first-party features and the deployment's seeded Plugin under the
// page's header, all of them in the tree at 3000px. More rows are a taller
// window here, not a scroll.
test.use({ viewport: { width: 1280, height: 3000 } });

async function openBotPlugins(page: Page): Promise<void> {
  // The Bot's own door: the Plugins row in its Settings, which is one level
  // under its page — the panel's root beside the conversation at this width.
  await openBotSettings(page);
  await tap(page, "bot-settings-plugins").click();
  await expect(sem(page, "plugins-document")).toBeVisible({
    timeout: SHELL_TIMEOUT_MS,
  });
  await settle(page);
}

test("a Bot's Plugins page is its own, and a switch it holds is the Bot's", async ({
  page,
  userId,
}, testInfo) => {
  await openApplication(page, userId);
  await createBot(page, "Plugged");
  await settle(page);

  // The Profile holds no second set of switches: a built-in feature is
  // switched per Bot, and a model provider is added in the Marketplace.
  await openProfileMenu(page);
  await expect(tap(page, "profile-models")).toBeVisible();
  await expect(says(page, "Account features")).toHaveCount(0);
  await expect(tap(page, "profile-plugins")).toHaveCount(0);
  await testInfo.attach("profile-menu.png", {
    body: await page.screenshot(),
    contentType: "image/png",
  });

  await closeOverlay(page);
  await settle(page);

  // The Bot's Plugins are Bot settings: the door is in its header.
  await openBotPlugins(page);

  // The four first-party features the panel offers, under the one "Built in"
  // label the projection files them under.
  await expect(sem(page, "view-group-built-in").first()).toBeVisible();
  for (const slug of ["web", "routines", "image", "subagents"]) {
    await expect(sem(page, `view-group-${slug}`).first()).toBeVisible();
  }
  // Choosing a model is a Settings decision, so it is never a card here.
  await expect(sem(page, "view-group-custom-models")).toHaveCount(0);

  // The locked card Plugins that draw what the conversation says (ADR 0030
  // step 7) run for every Bot and have nothing to switch, so they are not
  // rows: every row on this page is something the person can change.
  for (const title of ["Approval cards", "Question cards", "Agent cards"]) {
    await expect(says(page, title)).toHaveCount(0);
  }
  await testInfo.attach("bot-plugins-page.png", {
    body: await page.screenshot(),
    contentType: "image/png",
  });

  // Web is on for a Bot nobody has switched.
  const web = cardSwitch(page, "Web");
  await expect(web).toHaveAttribute("aria-checked", "true");
  await web.click();
  await expect(web).toHaveAttribute("aria-checked", "false", {
    timeout: 60_000,
  });
  await settle(page);
  await testInfo.attach("bot-plugins-web-off.png", {
    body: await page.screenshot(),
    contentType: "image/png",
  });

  // Read the page again from the Bot: the switch is stored, not painted.
  await page.reload();
  await expect(sem(page, "shell-conversation")).toBeVisible({
    timeout: SHELL_TIMEOUT_MS,
  });
  await settle(page);
  await openBotPlugins(page);
  await expect(cardSwitch(page, "Web")).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await expect(cardSwitch(page, "Routines")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await testInfo.attach("bot-plugins-reread.png", {
    body: await page.screenshot(),
    contentType: "image/png",
  });

  // A second Bot of the same account is untouched: the switch was this Bot's.
  await createBot(page, "Untouched");
  await settle(page);
  await openBotPlugins(page);
  await expect(cardSwitch(page, "Web")).toHaveAttribute("aria-checked", "true");
  await testInfo.attach("second-bot-plugins.png", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});

test("the Bot's Plugins route refuses a stale switch, an unknown plugin and a bad id", async ({
  page,
  userId,
}) => {
  await openApplication(page, userId);
  await createBot(page, "Fenced");
  await settle(page);

  // The Bot the page is reading, taken from the read the page itself made.
  const read = page.waitForResponse((response) =>
    /\/api\/bots\/[^/]+\/plugins/u.test(response.url()),
  );
  await openBotPlugins(page);
  const botId = decodeURIComponent(
    new URL((await read).url()).pathname.split("/")[3]!,
  );

  const post = (body: unknown) =>
    page.request.post(`/api/bots/${encodeURIComponent(botId)}/plugins`, {
      headers: { "x-frockbot-user-id": userId },
      data: body as Record<string, unknown>,
      failOnStatusCode: false,
    });
  const command = (fields: Record<string, unknown>) => ({
    schemaVersion: 1,
    kind: "set-plugin-enabled",
    commandId: crypto.randomUUID(),
    enabled: true,
    ...fields,
  });

  // A switch sent from a page that read an older revision is refused rather
  // than silently undoing whoever wrote in between.
  const stale = await post(
    command({ pluginId: "web", enabled: false, expectedRevision: 7 }),
  );
  expect(stale.status()).toBe(200);
  expect(await stale.json()).toEqual({
    status: "conflict",
    currentRevision: 0,
  });

  // A Plugin this Bot could not run is not switchable by naming it.
  const unknown = await post(
    command({ pluginId: "nothing-here", expectedRevision: 0 }),
  );
  expect(await unknown.json()).toMatchObject({ status: "rejected" });

  // A malformed command is the caller's fault, and says so as a 400.
  const malformed = await post({ nope: true });
  expect(malformed.status()).toBe(400);

  // A bot id that cannot be decoded is a 400, not the error boundary's 500.
  const badId = await page.request.get("/api/bots/%ZZ/plugins", {
    headers: { "x-frockbot-user-id": userId },
    failOnStatusCode: false,
  });
  expect(badId.status()).toBe(400);
  expect(await badId.json()).toEqual({ error: "invalid bot id" });

  // And nothing was switched by any of it.
  const frame = await page.request.get(
    `/api/bots/${encodeURIComponent(botId)}/plugins`,
    { headers: { "x-frockbot-user-id": userId } },
  );
  expect(await frame.json()).toMatchObject({ revision: 0 });
});
