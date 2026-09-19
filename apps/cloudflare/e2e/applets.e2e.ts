// The Applets Package, end to end, against the real routes.
//
// `applets-shell.e2e.ts` proves the ready state — a published Applet, live in
// the canvas — with the Applet routes stubbed, because reaching it for real
// costs a container build. This spec is the other half: nothing is stubbed. A
// Bot Turn calls `applet_create`, and everything after that is production —
// the artifact-backed Applets member mounted through the isolate host, the
// User's Applet directory, the durable source root the scaffold is written
// into, the focus the create sets, the Bot's Applets list, and the full-window
// canvas reading the source back.
//
// What is not here, and why: publishing. `applets-publish.e2e.ts` is the whole
// of that half — write, check, publish, and the live Applet — and it pays for a
// real container build to get it. Running the same build twice in one suite
// buys nothing this spec does not already prove.
import type { Locator, Page, TestInfo } from "@playwright/test";
import {
  test,
  expect,
  answerComposer,
  enableApplets,
  provisionThroughApi,
  press,
  sem,
  composerInput,
} from "./fixtures.ts";
import {
  E2E_OLLAMA_GOOD_API_KEY,
  e2eFrockbotToolCallPrompt,
} from "./harness.ts";

const PHONE = { width: 390, height: 844 } as const;
const DESKTOP = { width: 1280, height: 800 } as const;

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(0);
}

/**
 * A Bot whose Turns reach the fake provider, with Applets held by the account.
 *
 * Through `provisionThroughApi`: nothing this spec asserts is about the
 * Packages page, the connect form or the create sheet, and the window it opens
 * in is the one the caller set rather than one provisioning needed. Applets go
 * on first, because the Bot page reads the account's features when the Bot is
 * opened.
 */
async function provision(
  page: Page,
  options: { userId: string; apiBaseUrl: string; botName: string },
): Promise<void> {
  await enableApplets(page, options.userId);
  await provisionThroughApi(page, {
    userId: options.userId,
    apiKey: E2E_OLLAMA_GOOD_API_KEY,
    apiBaseUrl: options.apiBaseUrl,
    botName: options.botName,
    // Custom models, as the UI walk this replaced turned on from Plugins.
    perBotModels: true,
  });
}

/**
 * Whether the User's Applet directory holds this Applet.
 *
 * The directory is the authority on what a Turn did, and it is what the next
 * load reads back — so this is what "the Turn finished" means here. The
 * transcript cannot say it: it is a reversed, virtualised list, so a message
 * that has scrolled above the fold is not in the accessibility tree at all and
 * counting bubbles counts what is on screen rather than what was said.
 */
async function directoryHolds(page: Page, name: string): Promise<boolean> {
  const response = await page.request.get(
    `/api/bots/${encodeURIComponent(await builderBotId(page))}/applets`,
  );
  const body = (await response.json()) as {
    applets: Array<{ displayName: string }>;
  };
  return body.applets.some((applet) => applet.displayName === name);
}

/**
 * One scripted Turn, then a reload.
 *
 * The reload is the point, not a workaround: the focus a Turn sets, the
 * directory entry it made, and the source it wrote are durable, so the client
 * reads them back from the routes on the next load rather than from anything
 * the Turn left in the page.
 */
async function runTool(
  page: Page,
  text: string,
  name: string,
  input: unknown,
  settled: () => Promise<boolean>,
): Promise<void> {
  const composer = composerInput(page);
  // The Applets tools are first-party registrations, so the scripted model
  // calls them by name, on its own line.
  //
  // Typed through `answerComposer` rather than filled: a draft that arrives
  // with characters missing is a Turn that calls no tool at all, which is what
  // "the directory never held the Applet" looked like from here. The engine
  // behaviour behind that is explained on `answerComposer`.
  await answerComposer(
    page,
    `${text}\n${e2eFrockbotToolCallPrompt(name, input)}`,
  );
  await press(sem(page, "send-button"));
  // The composer keeps the draft until the submission is accepted, so an empty
  // composer — not a click that returned — is the Turn being admitted.
  await expect(composer).toHaveValue("", { timeout: 120_000 });
  await expect.poll(settled, { timeout: 180_000 }).toBe(true);
  await page.reload();
  await expect(sem(page, "shell-conversation")).toBeVisible({
    timeout: 120_000,
  });
}

/**
 * The canvas's own name.
 *
 * The identifier and the name are on different nodes: `identified` annotates
 * the node it is given, and the canvas puts its "Applet <name>" label on a
 * semantics container inside that — so the name is a child's `aria-label`
 * rather than the identified node's.
 */
function named(canvas: Locator, name: string): Locator {
  return canvas.locator(`[aria-label*="Applet ${name}"]`);
}

/**
 * What the code view is showing, as a browser can see it: which file is open.
 *
 * Not what the file says. A `SelectableText` reaches the accessibility tree as
 * a read-only text field, and Flutter puts a text field's value in the DOM only
 * while it is being edited — so an Applet's source is on the canvas and nowhere
 * a spec can read it. Which file the view is on is a `ChoiceChip`, and that is
 * a checkbox with a state.
 */
function openFile(page: Page, path: string): Locator {
  return sem(page, `applet-file-${path}`);
}

/**
 * Whether the code view is on this file. The chip's state is on the node the
 * engine gave the checkbox role to, which is inside the identified one for the
 * same reason a button's is.
 */
function fileState(page: Page, path: string): Locator {
  const id = `applet-file-${path}`;
  return page
    .locator(
      `[flt-semantics-identifier="${id}"][aria-checked], ` +
        `[flt-semantics-identifier="${id}"] [aria-checked]`,
    )
    .first();
}

/**
 * The canvas, opened from the Bot page's All Applets row: it puts the selected
 * Bot's Applets in the sidebar (a pushed page on a phone), and a row opens one.
 */
async function openCanvas(page: Page): Promise<Locator> {
  const appletId = await appletIdFromDirectory(page);
  await expect(sem(page, `bot-page-applet-${appletId}`)).toBeVisible({
    timeout: 60_000,
  });
  await press(sem(page, "bot-page-applets-all").first());
  await expect(sem(page, "applet-list")).toBeVisible({ timeout: 60_000 });
  await press(
    page.locator('[flt-semantics-identifier^="applet-row-"]').first(),
  );
  const canvas = sem(page, "applet-canvas");
  await expect(canvas).toBeVisible({ timeout: 60_000 });
  return canvas;
}

test("a Bot creates an Applet, its Applets list opens the source, and deletion removes it", async ({
  page,
  userId,
  ollamaBaseUrl,
  allowedFailures,
}, testInfo: TestInfo) => {
  // An Applet with nothing published has no live page, and the route says so
  // with a 404 the canvas reads as its building state. The browser logs it
  // either way.
  allowedFailures.requests.push(/\/api\/bots\/[^/]+\/applets\/[^/]+\/ui$/u);
  allowedFailures.console.push(/Failed to load resource.*404/u);
  await provision(page, {
    userId,
    apiBaseUrl: ollamaBaseUrl,
    botName: "Builder",
  });
  await page.setViewportSize(DESKTOP);

  await expect(sem(page, "package-entry-applets-open")).toHaveCount(0);
  await expect(sem(page, "bot-page-applets-all")).toHaveCount(1);

  await runTool(
    page,
    "Build me a todo list.",
    "applet_create",
    { displayName: "Weekly Todos" },
    () => directoryHolds(page, "Weekly Todos"),
  );

  // `applet_create` focuses what it made, so the canvas opens on it, in its
  // building state, showing the scaffold the tool wrote into the durable root.
  const canvas = await openCanvas(page);
  await expect(named(canvas, "Weekly Todos")).toBeVisible();
  // The building view: the panel says where the work has got to, in words,
  // instead of one fixed line about the Applet not being live.
  const progress = sem(page, "applet-canvas-progress");
  await expect(progress).toBeVisible();
  await expect(progress).toContainText("Writing the code");
  // The scaffold the tool wrote, file by file, and a code view that moves to
  // whichever one is pressed.
  await expect(openFile(page, "server.ts")).toBeVisible();
  await expect(openFile(page, "ui.tsx")).toBeVisible();
  await press(openFile(page, "ui.tsx"));
  await expect(fileState(page, "ui.tsx")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await press(openFile(page, "server.ts"));
  await expect(fileState(page, "server.ts")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(fileState(page, "ui.tsx")).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("applets-created.png") });

  const box = await canvas.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(DESKTOP.width - 24);
  expect(box?.height ?? 0).toBeGreaterThan(DESKTOP.height - 24);
  await expect(sem(page, "shell-conversation")).not.toBeVisible();
  await press(sem(page, "applet-canvas-close"));
  await expect(sem(page, "shell-conversation")).toBeVisible();

  // The Bot's Applets list shows the durable Applet the Bot created.
  const appletId = await appletIdFromDirectory(page);
  await press(sem(page, "bot-page-applets-all"));
  await expect(sem(page, "applet-list")).toBeVisible({ timeout: 60_000 });
  const row = sem(page, `applet-row-${appletId}`);
  await expect(row).toBeVisible();
  await expect(row).toHaveAccessibleName("Weekly Todos");
  await expectNoHorizontalOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath("applets-list-real.png"),
  });
  await press(sem(page, "applet-list-back"));
  await expect(sem(page, "applet-list")).toHaveCount(0);

  // And deleting it takes the canvas and the row with it.
  await runTool(
    page,
    "Delete it.",
    "applet_delete",
    { appletId },
    async () => !(await directoryHolds(page, "Weekly Todos")),
  );
  await expect(sem(page, "bot-page-applets-all")).toBeVisible();
  await press(sem(page, "bot-page-applets-all"));
  await expect(sem(page, "applet-list")).toBeVisible({ timeout: 60_000 });
  await expect(
    page.locator('[flt-semantics-identifier^="applet-row-"]'),
  ).toHaveCount(0);
  await expect(sem(page, "applet-list")).toHaveAccessibleName(
    /No Applets yet\. Ask Builder to build one\./u,
  );
});

/**
 * The Builder Bot this spec provisions. Applets are listed per Bot (ADR 0027),
 * so every directory read names it rather than the bootstrapped General Bot.
 */
async function builderBotId(page: Page): Promise<string> {
  const response = await page.request.get("/api/bots");
  const body = (await response.json()) as {
    bots: Array<{ botId: string; initialName: string }>;
  };
  const botId = body.bots.find((bot) => bot.initialName === "Builder")?.botId;
  if (!botId) throw new Error("this account has no Builder Bot");
  return botId;
}

/** The Applet's id, read from the same directory as the native Applets list. */
async function appletIdFromDirectory(page: Page): Promise<string> {
  const response = await page.request.get(
    `/api/bots/${encodeURIComponent(await builderBotId(page))}/applets`,
  );
  const body = (await response.json()) as {
    applets: Array<{ appletId: string; displayName: string }>;
  };
  const applet = body.applets.find(
    (candidate) => candidate.displayName === "Weekly Todos",
  );
  if (!applet) throw new Error("the Applet directory has no Weekly Todos");
  return applet.appletId;
}

test("the Applets canvas fills the phone window", async ({
  page,
  userId,
  ollamaBaseUrl,
  allowedFailures,
}, testInfo: TestInfo) => {
  allowedFailures.requests.push(/\/api\/bots\/[^/]+\/applets\/[^/]+\/ui$/u);
  allowedFailures.console.push(/Failed to load resource.*404/u);
  await provision(page, {
    userId,
    apiBaseUrl: ollamaBaseUrl,
    botName: "Builder",
  });

  await runTool(
    page,
    "Build me a todo list.",
    "applet_create",
    { displayName: "Weekly Todos" },
    () => directoryHolds(page, "Weekly Todos"),
  );

  await page.setViewportSize(PHONE);
  await press(
    sem(page, "shell-sidebar")
      .locator('[flt-semantics-identifier^="sidebar-bot-"]')
      .filter({ hasText: "Builder" })
      .first(),
  );
  await press(sem(page, "bot-panel-toggle"));

  // On a phone nothing opens itself: the focused Applet is a control in the
  // Bot page, not a screen the User did not ask for.
  const chip = sem(page, "bot-page-applets-all");
  await expect(chip).toBeVisible({ timeout: 60_000 });
  await expect(sem(page, "applet-canvas")).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath("applets-phone-chip-real.png"),
  });

  // Opened, it is a page rather than a drawer: the Applet has the whole width.
  const canvas = await openCanvas(page);
  await expect(named(canvas, "Weekly Todos")).toBeVisible();
  const box = await canvas.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(PHONE.width - 24);
  expect(box?.height ?? 0).toBeGreaterThan(PHONE.height - 24);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath("applets-phone-real.png"),
  });
});
