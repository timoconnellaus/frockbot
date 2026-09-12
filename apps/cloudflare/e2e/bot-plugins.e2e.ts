// The Bot's own Plugins page, driven from the profile sheet (ADR 0026).
//
// The page is the Bot's: the profile entry names the selected Bot, the list is
// what that Bot could run, and a switch is that Bot's alone. This spec walks
// the product path — open the sheet, open the page, flip Web off — and then
// reads the same Bot's page back to prove the switch is what the Bot serves,
// not what the widget last painted.
import type { Locator, Page } from "@playwright/test";
import {
  closeOverlay,
  createBot,
  expect,
  openApplication,
  openProfileMenu,
  sem,
  SHELL_TIMEOUT_MS,
  test,
} from "./fixtures.ts";

/** Press a named widget; see `bot-settings.e2e.ts` for why both nodes. */
function tap(scope: Page | Locator, identifier: string) {
  const node = `[flt-semantics-identifier="${identifier}"]`;
  return scope.locator(`${node}[flt-tappable], ${node} [flt-tappable]`).first();
}

/** Let a pushed page finish arriving before pressing anything on it. */
async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(700);
}

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
 * The switch on one first-party card.
 *
 * A card's switch reaches the accessibility tree as a `switch` node whose
 * accessible name is the card's own title, which is how a reader tells the
 * five of them apart.
 */
function cardSwitch(page: Page, title: string): Locator {
  return page.getByRole("switch", { name: title, exact: true }).first();
}

async function openBotPlugins(page: Page): Promise<void> {
  // The Bot's own door: the Plugins button in its header, which opens the
  // panel beside the conversation at this width.
  await tap(page, "plugins-panel-toggle").click();
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

  // The Profile holds what applies to the whole account — the installed
  // list and Account features — and never a Bot's own switches.
  await openProfileMenu(page);
  await expect(says(page, "Account features").first()).toBeVisible();
  await expect(says(page, "Plugins · Plugged")).toHaveCount(0);
  await testInfo.attach("profile-menu.png", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  await closeOverlay(page);
  await settle(page);

  // The Bot's Plugins are Bot settings: the door is in its header.
  await openBotPlugins(page);

  // What the panel says it is, and the five first-party features it offers.
  await expect(says(page, "Plugins").first()).toBeVisible();
  for (const slug of [
    "web-built-in",
    "routines-built-in",
    "image-built-in",
    "subagents-built-in",
    "messages-built-in",
  ]) {
    await expect(sem(page, `view-group-${slug}`).first()).toBeVisible();
  }
  // Choosing a model is a Settings decision, so it is never a card here.
  await expect(sem(page, "view-group-custom-models-built-in")).toHaveCount(0);
  await testInfo.attach("bot-plugins-page.png", {
    body: await page.screenshot(),
    contentType: "image/png",
  });

  // Web is on for a Bot nobody has switched.
  const web = cardSwitch(page, "Web · Built in");
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
  await expect(cardSwitch(page, "Web · Built in")).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await expect(cardSwitch(page, "Routines · Built in")).toHaveAttribute(
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
  await expect(cardSwitch(page, "Web · Built in")).toHaveAttribute(
    "aria-checked",
    "true",
  );
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
