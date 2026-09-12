// Shared fixtures for the browser layer.
//
// The client is Flutter, which paints to a canvas: there is no DOM of its own
// to select. What there is instead is the engine's accessibility tree, held
// open from the first frame (`apps/native/lib/main.dart` calls
// `ensureSemantics()` on web), and every widget a spec touches carries a
// `Semantics(identifier:)` written once in `apps/native/lib/shell/
// semantics.dart`. So a selector here is that identifier, and `sem()` is the
// only way a spec reaches a widget.
//
// One consequence catches every new spec: prose a widget carries as a *label* —
// a document's status line, a group's facts line — is merged into an ancestor's
// `aria-label` rather than emitted as text, so `getByText` cannot see it and
// the assertion is `toHaveAttribute("aria-label", /…/)`. Real DOM text exists
// only for a button's label and for the value inside a text field.
//
// Two fixtures earn their place beyond convenience:
//
// - `page` fails the test on any console error, any uncaught page error, any
//   failed request and any response of 500 or worse. Incident 1 was a client
//   that swallowed an HTML error body as JSON: the visible symptom was a
//   console `Unexpected token '<'` and nothing else. A layer that does not
//   watch the console cannot see that class of bug at all. A test that expects
//   one allows it by pattern, explicitly.
// - `userId` gives every test a fresh `?as_user=` identity, so no two tests
//   share a User Durable Object and nothing has to be torn down between them.
import {
  expect,
  test as base,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";
import {
  e2eOllamaEndpointV1,
  E2E_OLLAMA_GOOD_API_KEY,
  type FakeOllamaChatMode,
} from "./harness.ts";

export interface E2EOptions {
  /** The fake Ollama server the harness started, as its bare origin. */
  ollamaServerUrl: string;
}

export interface AllowedFailures {
  /** Console and page-error messages this test expects. */
  console: RegExp[];
  /** URLs whose failed or 5xx responses this test expects. */
  requests: RegExp[];
}

interface E2EFixtures {
  userId: string;
  /**
   * The endpoint this test's Connection points at: the fake server, behind a
   * path that belongs to this test alone. See `e2eOllamaEndpointV1`.
   */
  ollamaBaseUrl: string;
  allowedFailures: AllowedFailures;
  serverReady: void;
}

/**
 * How long a test waits for the harness to have a server again.
 *
 * The supervisor's backoff is 1s, 2s, 4s, 8s, then 15s, and a fresh
 * `wrangler dev` takes a few seconds more to load the artifact. This budget
 * covers a couple of those without covering a genuinely dead harness — when it
 * runs out the test fails saying so, rather than failing on a locator nobody
 * can explain.
 */
const SERVER_READY_TIMEOUT_MS = 90_000;

/**
 * How long the shell may take to appear.
 *
 * The client is a 3 MB CanvasKit bundle: the browser downloads and compiles
 * the engine before the first frame, and then the shell reads the directory.
 * On a cold CI runner that is tens of seconds, and it is the one wait every
 * spec pays, so it is generous on purpose.
 */
export const SHELL_TIMEOUT_MS = 120_000;

/**
 * Wait until something is serving on `baseURL` again.
 *
 * `wrangler dev` has died mid-shard in CI more than once, and until the
 * harness learned to restart it every later spec failed on
 * `net::ERR_CONNECTION_REFUSED` — one crash cost a whole shard's evidence.
 * With the supervisor in front of it, this is what turns that into a single
 * failed test: the spec that was running when the runtime died still fails,
 * and the next one waits here for the replacement instead of racing it.
 *
 * `/favicon.ico` is a public asset path, so this needs no identity header, and
 * it is served by the loaded artifact — a 200 proves the replacement Worker has
 * its artifact back, not merely that a socket accepts. The client's own payload
 * would not: it is static assets the runtime answers without loading anything.
 */
async function waitForServer(baseURL: string): Promise<void> {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  let lastFailure = "no attempt was made";
  let attempts = 0;
  for (;;) {
    try {
      const response = await fetch(`${baseURL}/favicon.ico`);
      if (response.ok) {
        void response.arrayBuffer();
        return;
      }
      void response.arrayBuffer();
      lastFailure = `HTTP ${response.status}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    attempts += 1;
    if (Date.now() >= deadline) {
      throw new Error(
        `the e2e harness is not serving ${baseURL} after ${attempts} attempts: ${lastFailure}. ` +
          `The Worker probably died; see the harness log the webServer printed.`,
      );
    }
    await new Promise((sleep) => setTimeout(sleep, 500));
  }
}

interface Problem {
  kind: "console" | "pageerror" | "requestfailed" | "server-error";
  text: string;
}

/**
 * Record everything the page reports that a test might not have wanted.
 *
 * Separate from the `page` fixture because a spec file that provisions once
 * and hands the same page to every test in it (`shareProvisionedApplication`)
 * still owes each of those tests the same check.
 */
function collectProblems(page: Page): Problem[] {
  const problems: Problem[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      problems.push({ kind: "console", text: message.text() });
    }
  });
  page.on("pageerror", (error) => {
    problems.push({ kind: "pageerror", text: error.message });
  });
  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText ?? "failed";
    // `requestfailed` also fires for a request somebody cancelled, and the
    // client is a poller: closing the page or navigating away aborts whatever
    // poll is in flight. An abort is not a transport failure the product owns.
    if (failure === "net::ERR_ABORTED") return;
    problems.push({
      kind: "requestfailed",
      text: `${request.url()}: ${failure}`,
    });
  });
  page.on("response", (response) => {
    if (response.status() >= 500) {
      problems.push({
        kind: "server-error",
        text: `${response.status()} ${response.url()}`,
      });
    }
  });
  return problems;
}

/**
 * Fail unless every problem recorded is one the test said it expected.
 *
 * The allow-list is consulted here rather than at capture time, so a test may
 * declare what it expects at any point before it ends.
 */
function expectNoUnexpectedProblems(
  problems: readonly Problem[],
  allowed: AllowedFailures,
): void {
  const unexpected = problems.filter((problem) => {
    const patterns =
      problem.kind === "console" || problem.kind === "pageerror"
        ? allowed.console
        : allowed.requests;
    return !patterns.some((pattern) => pattern.test(problem.text));
  });
  expect(
    unexpected.map((problem) => `${problem.kind}: ${problem.text}`),
    "the page reported errors no test allowed",
  ).toEqual([]);
}

export const test = base.extend<E2EFixtures, E2EOptions>({
  ollamaServerUrl: ["", { scope: "worker", option: true }],

  userId: async ({}, use) => {
    await use(`e2e-${crypto.randomUUID()}`);
  },

  ollamaBaseUrl: async ({ ollamaServerUrl, userId }, use) => {
    await use(e2eOllamaEndpointV1(ollamaServerUrl, userId));
  },

  allowedFailures: async ({}, use) => {
    await use({ console: [], requests: [] });
  },

  serverReady: async ({ baseURL }, use) => {
    if (baseURL) await waitForServer(baseURL);
    await use();
  },

  // `serverReady` is a dependency rather than an `auto` fixture so it is
  // guaranteed to have finished before this one opens a page at an address
  // that may still be coming back up.
  page: async ({ page, allowedFailures, serverReady }, use) => {
    void serverReady;
    const problems = collectProblems(page);
    await use(page);
    expectNoUnexpectedProblems(problems, allowedFailures);
  },
});

/** What a spec file gets back when it provisions once for all of its tests. */
export interface SharedApplication {
  page: Page;
  /** The account every test in the file shares. */
  userId: string;
  /** That account's Connection endpoint, for `setFakeOllamaChatMode`. */
  ollamaBaseUrl: string;
}

/**
 * Provision one account, in one browser, for a whole spec file.
 *
 * Booting the client is the most expensive thing a test does — a 3 MB CanvasKit
 * bundle downloaded, compiled and painted — and walking `provisionThroughUi` is
 * the second: two Packages, a Connection and a default model, each a press on a
 * surface that has to arrive first. A file whose tests differ in what they do to
 * a Bot, rather than in what account they do it as, pays both once here.
 *
 * The tests then run in declaration order and share the page, so each one
 * starts from whatever the last left behind: a test that wants a conversation
 * of its own makes a Bot of its own. What is *not* shared is the check every
 * test gets from the `page` fixture — problems are attributed to the test that
 * was running when the page reported them.
 */
export function shareProvisionedApplication(options: {
  /** The Bot `provisionThroughUi` leaves selected, before any test runs. */
  botName: string;
  perBotModels?: boolean;
}): () => SharedApplication {
  let shared: SharedApplication | undefined;
  let context: BrowserContext | undefined;
  let problems: Problem[] = [];
  let seen = 0;
  let windowSize: { width: number; height: number } | null = null;

  test.beforeAll(async ({ browser, ollamaServerUrl }, testInfo) => {
    // The context options the project declares, named one at a time: the
    // project's `use` also carries this suite's own options, which
    // `newContext` would not know what to do with.
    const {
      baseURL,
      viewport,
      deviceScaleFactor,
      hasTouch,
      isMobile,
      userAgent,
      permissions,
      timezoneId,
      locale,
      colorScheme,
    } = testInfo.project.use;
    if (baseURL) await waitForServer(baseURL);
    context = await browser.newContext({
      baseURL,
      viewport,
      deviceScaleFactor,
      hasTouch,
      isMobile,
      userAgent,
      permissions,
      timezoneId,
      locale,
      colorScheme,
    });
    // Tracing and video are the project's own (`use.trace`, `use.video`):
    // Playwright arms them on every context the `browser` fixture makes,
    // including this one, and saves them when the context closes.
    const page = await context.newPage();
    problems = collectProblems(page);
    const userId = `e2e-${crypto.randomUUID()}`;
    const ollamaBaseUrl = e2eOllamaEndpointV1(ollamaServerUrl, userId);
    await provisionThroughUi(page, {
      userId,
      apiKey: E2E_OLLAMA_GOOD_API_KEY,
      apiBaseUrl: ollamaBaseUrl,
      botName: options.botName,
      ...(options.perBotModels ? { perBotModels: true } : {}),
    });
    windowSize = page.viewportSize();
    shared = { page, userId, ollamaBaseUrl };
  });

  test.beforeEach(async () => {
    seen = problems.length;
    const page = shared?.page;
    if (!page) return;
    // The page is handed on from the test before, which may have resized the
    // window or put a route in front of the network to make its own point.
    // Neither belongs to the test about to run.
    await page.unrouteAll({ behavior: "ignoreErrors" });
    if (windowSize) await page.setViewportSize(windowSize);
    // And it is left on the conversation, wherever the last test finished —
    // including a test that failed inside a settings sheet. Walking back is
    // cheap; reloading, which boots the engine again, is the fallback.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (
        await sem(page, "shell-conversation")
          .isVisible()
          .catch(() => false)
      ) {
        return;
      }
      await page.goBack().catch(() => undefined);
    }
    await page.reload();
    await expect(sem(page, "shell-conversation")).toBeVisible({
      timeout: SHELL_TIMEOUT_MS,
    });
  });

  test.afterEach(async ({ allowedFailures }, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus && shared) {
      // The project's `screenshot: only-on-failure` is the `page` fixture's,
      // and this page is not it: a failing test keeps the one thing that says
      // what was on screen.
      const path = testInfo.outputPath("failure.png");
      await shared.page.screenshot({ path }).catch(() => undefined);
      await testInfo.attach("failure", { path, contentType: "image/png" });
    }
    // Whatever the page reported while *this* test ran. A file-scoped page
    // outlives a test, so the slice — not the whole list — is this test's.
    expectNoUnexpectedProblems(problems.slice(seen), allowedFailures);
  });

  test.afterAll(async () => {
    await context?.close();
    context = undefined;
    shared = undefined;
  });

  return () => {
    if (!shared)
      throw new Error("the shared application was never provisioned");
    return shared;
  };
}

export { expect } from "@playwright/test";

/** The name every model reaches the UI under, from the fake catalog. */
export const E2E_MODEL_LABEL = "gpt-oss:20b";
export const E2E_CONNECTION_LABEL = "Local Ollama";

/**
 * The widget carrying `identifier`, as the engine put it in the semantics tree.
 *
 * Several nodes may share an identifier — one declared action drawn on every
 * row of a list, say — so a spec that means one of them scopes with
 * `within()` rather than taking `.first()` and hoping.
 */
export function sem(page: Page | Locator, identifier: string): Locator {
  return page.locator(`[flt-semantics-identifier="${identifier}"]`);
}

/**
 * The text input inside a named field.
 *
 * A Flutter text field reaches the accessibility tree as a real `<input>` (or
 * `<textarea>` for a multi-line one) nested in its semantics node, which is
 * what lets `fill()` and `press()` work against a canvas.
 */
export function field(page: Page | Locator, identifier: string): Locator {
  return sem(page, identifier).locator("input, textarea");
}

/**
 * Fill a document's fields, and prove the form still holds all of them.
 *
 * Reaching the next field while the last one's editing session is still closing
 * empties *the last one*, silently, and the action then refuses with "This
 * action still needs an answer" — which reads exactly like the product refusing
 * the form rather than like a lost keystroke.
 *
 * So the read-back is over every field after the last one is typed, not per
 * field as it is typed: `fill()` writes the input directly, so a read
 * immediately after it always agrees and would catch nothing.
 */
export async function answerFields(
  page: Page | Locator,
  values: Record<string, string>,
): Promise<void> {
  await answerInputs(
    Object.entries(values).map(([id, value]) => [
      field(page, `view-field-${id}`),
      value,
    ]),
  );
}

/**
 * The same, for inputs a spec reached some other way — a provider's connect
 * form names its fields by label rather than by an id that carries the
 * provider's position in the document.
 *
 * Typed, never filled, and the read-back is what decides. A Flutter text
 * field's `<input>` is a live editing element only while the engine holds an
 * editing session open on it: `fill()` sets `.value` and dispatches `input`,
 * and with no session open the engine never reads it — while `inputValue()`
 * reads back the very value the engine ignored, so a blind read-back can agree
 * about a widget that holds nothing. This used to fill on the first attempt
 * and type only on a retry, which meant nothing on this side could tell a form
 * that was answered from one that merely looked answered: a connect form went
 * out with a key the widget had never held, and the only thing that reported
 * it was the account coming back refused.
 */
export async function answerInputs(
  entries: readonly (readonly [Locator, string])[],
): Promise<void> {
  for (const [input] of entries) await expect(input).toBeVisible();
  // A Flutter field's editing element exists only while the engine is holding
  // a session open on it, and the engine tears one down whenever the widget is
  // rebuilt from Dart. This project sets no action timeout, so a read that
  // caught a rebuild waited for an element that was never coming back and
  // spent the whole test's budget on it. Bounded, an unreadable field is one
  // that does not hold what this wants — which is what the retry is for.
  const read = (input: Locator) =>
    input.inputValue({ timeout: 15_000 }).catch(() => undefined);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    for (const [input, value] of entries) {
      if ((await read(input)) === value) continue;
      // Typed rather than filled, from the first attempt. `fill` writes the
      // element's value and dispatches `input`, which the engine reads only
      // while it is holding an editing session open on that field — and
      // `inputValue()` then reads back the very value the engine ignored, so
      // the check below can agree about a widget that holds nothing at all.
      // A form that looked answered and was not is how a credential reached
      // the product half-typed, and no read on this side could have caught
      // it. Typing into a focused field always reaches the widget.
      //
      // Focused rather than clicked. A click needs coordinates, and on a form
      // whose fields' semantics nodes overlap it opens the editing session on
      // whichever field is really under the pointer — `pressSequentially` then
      // types into that one. Forcing the click only turns off the check that
      // would have caught it: this is how a base URL ended up in the API key.
      // `focus()` names the element and involves no geometry at all.
      await input.focus();
      await input.press("ControlOrMeta+a");
      // Emptying a field is a keystroke of its own: selecting everything and
      // then typing nothing leaves the selection standing and the text where
      // it was, so a spec that put a field back to blank found its next answer
      // typed onto the end of the old one.
      if (value.length === 0) await input.press("Backspace");
      // Line by line, with Shift+Enter between them. A bare Enter is Send in
      // the composer wherever there is a keyboard with a Shift key, and
      // `pressSequentially` turns a "\n" into exactly that key — so a
      // multi-line draft typed in one go went out at its first line, and the
      // read-back below found a field holding the rest. Shift+Enter is the
      // line break on every multi-line field, the composer included.
      else {
        const lines = value.split("\n");
        for (const [index, line] of lines.entries()) {
          if (index > 0) await input.press("Shift+Enter");
          if (line.length > 0) await input.pressSequentially(line);
        }
      }
    }
    // A second pass over every field once the last one is typed, because what
    // a stray edit empties is the field *before* the one being typed. A plain
    // read rather than an `expect`: a field that snapped back costs one read
    // and another attempt, where a polling assertion would wait out its whole
    // timeout with nobody left to re-type it.
    //
    // Read while the session is still open, which is the only time a Flutter
    // field's text is in the DOM at all: a blurred field reads back empty
    // whatever it is showing a person, so a check on the far side of the blur
    // fails every form it is asked about.
    let missing = false;
    for (const [input, value] of entries) {
      if ((await read(input)) !== value) missing = true;
    }
    if (missing) continue;
    // The editing session is closed before the caller goes on to press
    // something. While one is open the engine keeps its own input element over
    // the canvas, and that element answers `elementFromPoint` for the button
    // the spec is about to click — which reads as "`<flutter-view>` intercepts
    // pointer events" and retries until the action times out. Blurring hands
    // the field's value to the widget and takes the overlay away.
    for (const [input] of entries) {
      await input.evaluate((element: HTMLElement) => element.blur());
    }
    return;
  }
  throw new Error("the form would not hold what this spec typed into it");
}

/**
 * Open the application as a fresh development identity.
 *
 * `?as_user=` is the gateway's development identity: it answers the request as
 * that user and sets the `frockbot_dev_user` cookie, so every later request in
 * this browser context is the same user without the parameter. The Worker
 * stamps the account onto the document, so the client paints the shell rather
 * than the sign-in door — waiting for the sidebar (wide) or the button that
 * opens it (phone) is waiting for exactly that.
 */
export async function openApplication(
  page: Page,
  userId: string,
): Promise<void> {
  await page.goto(`/?as_user=${userId}`);
  await expect(
    sem(page, "shell-sidebar").or(sem(page, "sidebar-toggle")),
  ).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
}

/**
 * Turn Applets on for this test's account, as an admin would from Site
 * administration.
 *
 * The feature is off for every account until an admin turns it on, and the
 * fresh `?as_user=` identity a spec runs as is not one: the e2e stack names an
 * admin email nobody signs in with. The gateway's own development identity is
 * an admin unconditionally, and the header form of it is honoured per request
 * and sets no cookie — so this call speaks as that admin without moving the
 * page's session off the account under test.
 */
export async function enableApplets(page: Page, userId: string): Promise<void> {
  const response = await page.request.post(
    `/api/admin/users/${encodeURIComponent(userId)}/features`,
    {
      headers: { "x-frockbot-user-id": "development" },
      data: { schemaVersion: 1, type: "user/set-features", applets: true },
    },
  );
  expect(response.status(), await response.text()).toBe(200);
}

/**
 * Turn Plugin authoring on for one account, as the admin does (ADR 0026's
 * master toggle). The command carries `applets` as well; it is left off.
 */
export async function enablePluginAuthoring(
  page: Page,
  userId: string,
): Promise<void> {
  const response = await page.request.post(
    `/api/admin/users/${encodeURIComponent(userId)}/features`,
    {
      headers: { "x-frockbot-user-id": "development" },
      data: {
        schemaVersion: 1,
        type: "user/set-features",
        applets: false,
        pluginAuthoring: true,
      },
    },
  );
  expect(response.status(), await response.text()).toBe(200);
}

/**
 * Make the sidebar reachable, whatever the layout.
 *
 * Below the phone breakpoint the Bot list is the first screen and a
 * conversation is a page over it, so a helper that clicks something in the
 * list has to go back to it first — and a helper that clicks two things, on
 * two surfaces, has to go back twice. At wider widths there is no toggle and
 * this does nothing, which is what lets every helper below call it
 * unconditionally.
 */
export async function revealSidebar(page: Page): Promise<void> {
  const toggle = sem(page, "sidebar-toggle");
  if (!(await toggle.isVisible().catch(() => false))) return;
  if (
    await sem(page, "shell-sidebar")
      .isVisible()
      .catch(() => false)
  )
    return;
  await toggle.click();
  await expect(sem(page, "shell-sidebar")).toBeVisible();
}

/** Create a Bot from the sidebar's own gesture, and select it. */
export async function createBot(
  page: Page,
  name: string,
  options: { firstMessage?: string } = {},
): Promise<void> {
  await revealSidebar(page);
  await sem(page, "sidebar-create-bot").click();
  const sheet = sem(page, "flock-create");
  await expect(sheet).toBeVisible();
  await field(page, "flock-create-name").fill(name);
  if (options.firstMessage !== undefined) {
    await field(page, "flock-create-first-message").fill(options.firstMessage);
  }
  await sem(page, "flock-create-submit").click();
  await expect(sheet).toBeHidden({ timeout: 60_000 });
}

/** The sheet the list's own avatar opens: every account surface is in it. */
export async function openProfileMenu(page: Page): Promise<void> {
  await revealSidebar(page);
  await sem(page, "sidebar-profile").click();
  await expect(sem(page, "profile-menu")).toBeVisible();
  await settle(page);
}

/**
 * Wait for a surface that is still moving.
 *
 * The engine rebuilds the accessibility tree when the semantics change, not
 * every frame, so a sliding sheet reaches the DOM at its final box while the
 * canvas is still somewhere else. Playwright sees a stable element and presses
 * it; the engine hit-tests that press against the frame it is painting, and the
 * press lands on whatever is really under the pointer. Waiting out the
 * transition is the only thing that fixes it.
 */
export async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(700);
}

/**
 * Open one of the profile sheet's entries and wait for the surface it names.
 *
 * `marker` has to be something only that surface draws. Settings and Models are
 * both `settings-document`, so waiting on the document meant a press that
 * landed on the wrong row of a still-sliding sheet still reported success — and
 * the spec then asserted about a surface it had not opened.
 */
async function openProfileSurface(
  page: Page,
  entry: string,
  marker: string,
): Promise<void> {
  await expect(async () => {
    await openProfileMenu(page);
    await press(sem(page, entry));
    await expect(sem(page, marker)).toBeVisible({ timeout: 10_000 });
  }).toPass({ timeout: 120_000 });
}

/** Open Plugins: what this account has, and whether it is on. */
export async function openPlugins(page: Page): Promise<void> {
  await openProfileSurface(page, "profile-plugins", "plugins-document");
}

/** Open Models: the account's default model, and the providers behind it. */
export async function openModels(page: Page): Promise<void> {
  await openProfileSurface(page, "profile-models", "settings-model-field");
}

/**
 * Open the Marketplace: the services a User authorizes once for every Bot
 * they own. Its door is on the Bot list itself rather than in the profile
 * sheet — beside the avatar on a phone, the foot of the column on a desktop —
 * and the same identifier names both. On a desktop it is a dialog over the
 * shell, on a phone a page; the document's marker is the same in either.
 */
export async function openConnectors(page: Page): Promise<void> {
  await expect(async () => {
    await revealSidebar(page);
    await press(sem(page, "sidebar-marketplace"));
    await expect(sem(page, "connections-document")).toBeVisible({
      timeout: 10_000,
    });
  }).toPass({ timeout: 120_000 });
}

/** Open account Settings. */
export async function openSettings(page: Page): Promise<void> {
  await openProfileSurface(page, "profile-settings", "settings-document");
}

/**
 * The `group` node a projection titled `title`.
 *
 * A document's own controls are named by the projection's ids, so a spec that
 * means "the Ollama Cloud row's button" scopes the action to the group whose
 * title is the Package's name.
 */
export function group(page: Page, title: string): Locator {
  return sem(
    page,
    `view-group-${title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")}`,
  );
}

/** A declared action's button, optionally scoped to the group it is drawn in. */
export function action(scope: Page | Locator, actionId: string): Locator {
  return sem(scope, `view-action-${actionId}`);
}

/**
 * Everything a region says, whether the engine drew it as text or as a label.
 *
 * A canvas has no text for a reader to select, so Flutter writes a widget's
 * words into the semantics tree — sometimes as the node's own content, and
 * sometimes, where a `MergeSemantics` collapses a row into one node, as that
 * node's `aria-label`. `toContainText` reads only the first kind, so a spec
 * that asserted a sentence the product was drawing correctly could fail over
 * which of the two the engine had chosen. This reads both.
 */
export async function spokenText(scope: Locator): Promise<string> {
  return scope.evaluate((node) => {
    const said: string[] = [node.textContent ?? ""];
    for (const labelled of [node, ...node.querySelectorAll("[aria-label]")]) {
      const label = labelled.getAttribute("aria-label");
      if (label) said.push(label);
    }
    return said.join("\n");
  });
}

/**
 * Whether a named control is refusing to be pressed.
 *
 * `identified()` puts the identifier on a `Semantics` node of its own, and the
 * engine puts the button — with `aria-disabled` on it — on that node or on a
 * child of it, depending on whether the two collapsed into one. So a spec that
 * read `aria-disabled` off the identified node alone was reading `null` from a
 * control that was plainly disabled on screen, and the negative form of that
 * assertion passed whatever the button was doing.
 */
export async function pressDisabled(scope: Locator): Promise<boolean> {
  return scope.evaluate(
    (node) =>
      node.getAttribute("aria-disabled") === "true" ||
      node.querySelector('[aria-disabled="true"]') !== null,
  );
}

/** A `field` node's input, by the id the document gave it. */
export function documentField(page: Page, id: string): Locator {
  return field(page, `view-field-${id}`);
}

/**
 * Close whichever surface is open, back to the conversation.
 *
 * Popped until the conversation is under the finger rather than exactly once:
 * Profile is a page of its own and the account destinations push above it, so
 * Back from Models lands on Profile rather than on the thread. How many pages
 * a surface was opened through is the shell's business; what a spec means by
 * "close this" is "give me the conversation back".
 */
export async function closeOverlay(page: Page): Promise<void> {
  const conversation = sem(page, "shell-conversation");
  for (let depth = 0; depth < 3; depth += 1) {
    await page.goBack();
    try {
      await expect(conversation).toBeVisible({ timeout: 5_000 });
      return;
    } catch {
      // Another page still stands between here and the thread.
    }
  }
  await page.goBack();
  await expect(conversation).toBeVisible();
}

/**
 * Press a control the document named.
 *
 * A `view` action is an `Align` around its button. Where the align is as wide
 * as the surface and the button is only as wide as its label, the identifier
 * lands on a node whose centre is empty space and a click there reaches the
 * canvas instead of the button — so the press goes to the child the engine
 * marked as a button. Where the two collapse into one node, there is no child
 * and the node itself is the button.
 */
export async function press(scope: Locator): Promise<void> {
  // `[flt-tappable]` rather than `[role="button"]`: a switch and a list tile
  // are tappable and neither is a button, and the engine marks all three.
  const tappable = scope.locator("[flt-tappable]").first();
  const target = (await tappable.count()) > 0 ? tappable : scope;
  try {
    // Bounded rather than left on the test timeout: a control that is not
    // there is a spec looking in the wrong place, and it should say so in
    // seconds rather than spend ten minutes reporting it as a click that
    // timed out.
    await target.click({ timeout: 15_000 });
  } catch (error) {
    // A canvas has one hit-test surface, and the engine stacks it over the
    // semantics tree while a surface is settling: the node is visible,
    // enabled and stable, and `<flutter-view>` still answers for every point
    // inside it, so a real click never reaches it. Activation is not
    // geometry — the engine listens for `click` on the semantics element
    // itself — so the press is dispatched to the node this spec named.
    //
    // Deliberately not `force: true`, which keeps the coordinates and only
    // turns off the check that would have caught them: this cannot land on a
    // widget other than the one asked for.
    if (!String(error).includes("intercepts pointer events")) throw error;
    await target.dispatchEvent("click");
  }
}

/**
 * Turn a Package on from its Plugins row.
 *
 * The wheel is the only way down a Flutter list: it is a canvas, so there is
 * nothing for `scrollIntoView` to scroll. The loop stops on the control
 * *existing* rather than on its box reaching a coordinate — a row that is off
 * screen is not in the accessibility tree at all, so presence is the signal,
 * and once the node exists Playwright's own scroll-into-view covers the last
 * few pixels of the press. Steering by a measured gap does not converge: the
 * semantics boxes are rebuilt behind the paint, so each correction is computed
 * from a stale position and the list oscillates past the row forever.
 */
export async function enablePackage(page: Page, title: string): Promise<void> {
  if (title === "Ollama Cloud") {
    await chooseOllamaProvider(page);
    return;
  }
  await openProfileSurface(page, "profile-capabilities", "plugins-document");
  const search = page.getByRole("textbox").first();
  await search.fill(title);
  const toggle = page.getByRole("switch", { name: title, exact: true });
  if (!(await toggle.isChecked())) await press(toggle);
  await expect(toggle).toBeChecked({ timeout: 30_000 });
  await closeOverlay(page);
}

/**
 * Switch Custom models on. The platform chooses the model, so choosing one at
 * all — and every model provider besides the built-in one — is behind this one
 * Package, which ships disabled.
 */
export async function enableCustomModels(page: Page): Promise<void> {
  await enablePackage(page, "Custom models");
}

/**
 * Install the Ollama Cloud provider, which is done on Models rather than in
 * Plugins: a model provider is not a Plugins row, and Connectors offers its
 * connect form only once the Package is installed.
 *
 * A provider nobody has set up is not a section of its own. Models offers the
 * whole catalog through one "Add a provider" select, and a provider earns its
 * section — with "Manage provider" beside its name — once it has been chosen
 * there. Choosing hands the person to the provider's Connectors page, which is
 * where `connectOllama` picks up; this only comes back to Models to see the
 * section it made.
 */
export async function chooseOllamaProvider(page: Page): Promise<void> {
  await openModels(page);
  const section = group(page, "Ollama Cloud");
  const adder = group(page, "Add a provider");
  await expect(section.or(adder).first()).toBeVisible({
    timeout: SHELL_TIMEOUT_MS,
  });
  if (!(await section.getByText("Manage provider").count())) {
    // The select's id carries the section's index in the document, which a
    // spec has no business knowing, so it is found by the field it names.
    await press(
      adder.locator(
        '[flt-semantics-identifier^="view-field-j"][flt-semantics-identifier$=".provider"]',
      ),
    );
    await settle(page);
    const choice = page.locator('[aria-label="Ollama Cloud"]').last();
    await expect(choice).toBeVisible({ timeout: 30_000 });
    await choice.click();
    await settle(page);
    await press(
      adder.locator('[flt-semantics-identifier^="view-action-save-"]').first(),
    );
    await expect(sem(page, "connections-document")).toBeVisible({
      timeout: 60_000,
    });
    await page.goBack();
    await expect(section.getByText("Manage provider")).toBeVisible({
      timeout: 60_000,
    });
  }
  await closeOverlay(page);
}

/**
 * Connect an Ollama Cloud account on Connectors, and wait for *that* account.
 *
 * The form is answered once and submitted once. It used to be answered again
 * from scratch — disconnecting whatever the last attempt had left behind —
 * because a press that the canvas swallowed looked exactly like a credential
 * that never landed. Both halves of that are gone: `answerInputs` proves every
 * field holds what this spec typed before anything is submitted, and `press`
 * activates the named node rather than a point on the canvas, so a submission
 * that returned is a submission the product received. Answering a credential
 * form twice is not something a person does, and a helper that did it hid
 * whatever made the first attempt fail.
 *
 * What is still asked repeatedly is the *read*: the catalogue is refreshed
 * behind the connect while a `ViewSurfacePage` re-reads only when something is
 * pressed, so the row is pressed again rather than waited on. That loop writes
 * nothing.
 *
 * The wait is scoped to the provider's own group: Frock AI is connected out of
 * the box and its row says the same words from the first frame.
 */
export async function connectOllama(
  page: Page,
  options: { apiKey: string; apiBaseUrl: string; label?: string },
): Promise<void> {
  await openModels(page);
  await press(
    group(page, "Ollama Cloud")
      .locator('[flt-semantics-identifier^="view-action-section-"]')
      .first(),
  );
  await expect(sem(page, "connections-document")).toBeVisible({
    timeout: 60_000,
  });
  const provider = group(page, "Ollama Cloud");
  await expect(provider).toBeVisible({ timeout: 60_000 });
  await press(provider.getByText("Connect", { exact: true }));
  await press(provider.getByText("Advanced — custom server", { exact: true }));
  await answerInputs([
    [
      provider.locator('input[aria-label="Account name"]'),
      options.label ?? E2E_CONNECTION_LABEL,
    ],
    [provider.locator('input[aria-label="API base URL"]'), options.apiBaseUrl],
    [provider.locator('input[aria-label="API key"]'), options.apiKey],
  ]);
  await press(action(provider, "connect-0"));
  // The account's state is read from the row's accessible name, not its text:
  // the compact Connectors page folds a provider's title, pill and account
  // lines into one labelled node, so "Ready" is in `aria-label` and never in
  // the text content a `toContainText` would read. The buttons are the only
  // text left there.
  await expect(async () => {
    await press(sem(page, "connections-refresh"));
    await expect(provider.getByLabel(/\bReady\b/u)).toBeVisible({
      timeout: 10_000,
    });
  }).toPass({ timeout: 90_000 });
  await closeOverlay(page);
}

/**
 * Choose, and save, the default model every new Bot starts on.
 *
 * Two steps a person makes that a spec would otherwise skip: the surface read
 * its catalogue before the account existed, so it is refreshed first or the
 * picker says "No matching models"; and the picker only stages a choice, which
 * the group's own Save is what writes.
 */
export async function chooseDefaultModel(
  page: Page,
  optionLabel: string,
): Promise<void> {
  await openModels(page);
  await press(sem(page, "settings-refresh"));
  await sem(page, "settings-model-field").click();
  const picker = sem(page, "model-picker");
  await expect(picker).toBeVisible();
  const option = sem(page, `model-option-${optionLabel}`);
  await expect(option).toBeVisible({ timeout: 60_000 });
  await option.click();
  await expect(picker).toBeHidden();
  await press(action(sem(page, "settings-document"), "save-0"));
  await expect(
    sem(page, "settings-model-field").getByText(optionLabel),
  ).toBeVisible({ timeout: 60_000 });
  await closeOverlay(page);
}

/**
 * The whole path a User walks before a first conversation with a Bot that
 * answers from the fake provider: the two Packages, the account, the model, the
 * Bot. Every step is a press a person makes, so the specs that need a working
 * Bot prove the path as a side effect of using it.
 *
 * Both Packages, because Connectors offers a provider's connect form only once
 * that provider's own Package is on, and Ollama Cloud ships off just as Custom
 * models does.
 */
export async function provisionThroughUi(
  page: Page,
  options: {
    userId: string;
    apiKey: string;
    apiBaseUrl: string;
    botName: string;
    /**
     * Also turn on Custom models, the Package behind a *per-Bot* model
     * override. Off by default: choosing the account's own default needs none
     * of it, and a spec that asserts a Bot has no model row of its own would
     * be undone by provisioning that quietly installed one.
     */
    perBotModels?: boolean;
  },
): Promise<void> {
  // Provisioned in a window tall enough that a Plugins row is on screen
  // without scrolling, and restored afterwards. Steering a Flutter list by the
  // wheel is not something to build a suite on: the engine drops a row out of
  // the accessibility tree as the list moves and does not reliably put it
  // back, so a row can be absent for a dozen consecutive scroll steps while
  // its neighbours are present throughout. Nothing about turning a Package on
  // is a claim about the size of the window, so the size a spec means is the
  // one it set, and this is not it.
  const viewport = page.viewportSize();
  await page.setViewportSize({ width: 1280, height: 1800 });
  await openApplication(page, options.userId);
  if (options.perBotModels) await enablePackage(page, "Custom models");
  await chooseOllamaProvider(page);
  await connectOllama(page, {
    apiKey: options.apiKey,
    apiBaseUrl: options.apiBaseUrl,
  });
  await chooseDefaultModel(
    page,
    `${E2E_MODEL_LABEL} · ${E2E_CONNECTION_LABEL}`,
  );
  await createBot(page, options.botName);
  if (viewport) await page.setViewportSize(viewport);
  await expectReadyToSend(page);
}

/**
 * Put a draft into the composer and prove the *widget* holds it, not only the
 * element.
 *
 * `answerInputs` reads the draft back from the DOM, which is the very value
 * the engine ignores when the keys arrived before it had opened the field's
 * editing session — and the composer is the one field where that shows: the
 * corner button is the microphone while the widget's draft is empty and Send
 * once it is not. So the draft is typed until the corner agrees with it — Send
 * standing for a draft, the microphone for a clear — and retyped through the
 * same path when the engine dropped it. A Main run failed three retries in a
 * row with the whole prompt in the element and the microphone still in the
 * corner; this is what tells the two apart.
 */
export async function answerComposer(page: Page, text: string): Promise<void> {
  const composer = composerInput(page);
  const sendsStanding = text.length > 0 ? 1 : 0;
  for (let attempt = 0; ; attempt += 1) {
    await answerInputs([[composer, text]]);
    try {
      await expect(sem(page, "send-button")).toHaveCount(sendsStanding, {
        timeout: 8_000,
      });
      return;
    } catch (error) {
      if (attempt >= 2) throw error;
      // The engine dropped the keys; put the element back and go again. Every
      // call is bounded the way `answerInputs` bounds its own reads: the state
      // being recovered from is the engine having torn the field's editing
      // session down, so the element may be gone — and this project sets no
      // action timeout, so an unbounded wait for it would spend the whole
      // test's budget and report an opaque timeout instead of this failure.
      await composer.focus({ timeout: 15_000 });
      await composer.press("ControlOrMeta+a", { timeout: 15_000 });
      await composer.press("Backspace", { timeout: 15_000 });
    }
  }
}

/**
 * Wait until this client could start a Turn.
 *
 * The composer's field is never disabled — readiness is about the transport,
 * the Bot and the model, and the answer is on Send. An empty draft disables
 * Send too, so readiness is asked with something in the composer and the draft
 * is put back afterwards.
 */
export async function expectReadyToSend(page: Page): Promise<void> {
  const composer = composerInput(page);
  await expect(composer).toBeVisible({ timeout: 60_000 });
  const draft = await composer.inputValue();
  await answerComposer(page, draft.length > 0 ? draft : "ready?");
  await expect
    .poll(() => pressDisabled(sem(page, "send-button")), { timeout: 60_000 })
    .toBe(false);
  // Put back through the same path it was typed through, corner and all. A
  // clear that reached the element alone leaves the widget still holding the
  // question this asked, and the next spec's message goes out typed onto it.
  await answerComposer(page, draft);
}

/** The message composer's own input. */
export function composerInput(page: Page): Locator {
  return field(page, "chat-composer");
}

/** Every message the thread is showing. */
export function transcriptMessages(page: Page): Locator {
  return sem(page, "chat-transcript").locator(
    '[flt-semantics-identifier^="message-"]',
  );
}

/**
 * Send a message and wait for the Turn to settle.
 *
 * Generous on time by design. The first Turn of a run is the coldest path in
 * the product — the gateway loads the application isolate, the Bot Durable
 * Object starts, its Composition mounts — and on a CI runner that is several
 * times slower than a laptop. The composer keeps the draft until the
 * submission is accepted, so an empty composer, and not a click that returned,
 * is the signal that the Turn was admitted.
 */
export async function sendMessage(
  page: Page,
  text: string,
  // How many messages the Bot is expected to send back, and it is *not* one by
  // default. The thread draws what the Bot said to the person, which is what
  // `send_to_user` carries — a Turn whose model only wrote text settles with no
  // `responseText` and leaves the thread with the person's message and nothing
  // after it. A caller that wants a visible reply scripts one and says so.
  options: { replies?: number } = {},
): Promise<void> {
  const composer = composerInput(page);
  // Counted before the send, because "settled" means this many *more* messages
  // than the thread already had.
  const messages = transcriptMessages(page);
  const before = await messages.count();
  // The thread is a lazy list: only the rows on screen exist in the tree, so
  // on a long thread the count stops growing at what fits and a new message
  // shows as a different row at the bottom instead. Both are read.
  const newest = async () =>
    (await messages.count()) === 0
      ? ""
      : ((await messages.last().getAttribute("flt-semantics-identifier")) ??
        "");
  const newestBefore = await newest();
  // Typed through the same retry the connect form needs: the engine drops keys
  // sent before it has opened the field's editing session, and a draft that
  // arrives with its first few characters missing is a different message —
  // which, when the draft carries a tool script, is a different Turn.
  await answerComposer(page, text);
  await press(sem(page, "send-button"));
  await expect(composer).toHaveValue("", { timeout: 120_000 });
  // The person's own bubble, which is a row in the thread rather than text in
  // it: a user message reaches the accessibility tree as a disabled textarea
  // whose value is empty, so the count is what says the Turn was admitted.
  //
  // A floor rather than an equality. A Turn that settles inside the same poll
  // has already put the Bot's bubbles in the thread, so the exact count at
  // this moment is "one more, plus however many the Bot has managed" — which
  // is not a number this side can know. What the Turn was admitted at all is
  // the claim here; the settled count is asserted below, where it is exact.
  await expect
    .poll(
      async () =>
        (await messages.count()) >= before + 1 ||
        (await newest()) !== newestBefore,
      {
        timeout: 120_000,
        message: "the person's message never reached the thread",
      },
    )
    .toBe(true);
  // There is no SSE: the client POSTs the Turn and polls the run. The Turn has
  // settled when the working row has gone and whatever the Bot said is drawn.
  await expect(sem(page, "working-indicator")).toHaveCount(0, {
    timeout: 120_000,
  });
  const replies = options.replies ?? 0;
  if (replies > 0) {
    await expect(messages).toHaveCount(before + 1 + replies, {
      timeout: 120_000,
    });
  }
}

/**
 * Point the fake provider at a chat mode; `unauthorized` revokes the key and
 * `slow` holds every completion open long enough to reload the page mid-Turn.
 */
export async function setFakeOllamaChatMode(
  page: Page,
  ollamaBaseUrl: string,
  mode: FakeOllamaChatMode,
): Promise<void> {
  const response = await page.request.post(`${ollamaBaseUrl}/__e2e/chat-mode`, {
    data: { mode },
  });
  expect(response.ok(), "the fake Ollama server accepted the mode").toBe(true);
}
