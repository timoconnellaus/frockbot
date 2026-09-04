// Shared fixtures for the browser layer.
//
// Two of them earn their place beyond convenience:
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
  type Locator,
  type Page,
} from "@playwright/test";
import type { FakeOllamaChatMode } from "./harness.ts";

export interface E2EOptions {
  /** The fake Ollama server the harness started, for `api-base-url`. */
  ollamaBaseUrl: string;
}

export interface AllowedFailures {
  /** Console and page-error messages this test expects. */
  console: RegExp[];
  /** URLs whose failed or 5xx responses this test expects. */
  requests: RegExp[];
}

interface E2EFixtures {
  userId: string;
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
 * Wait until something is serving on `baseURL` again.
 *
 * `wrangler dev` has died mid-shard in CI more than once, and until the
 * harness learned to restart it every later spec failed on
 * `net::ERR_CONNECTION_REFUSED` — one crash cost a whole shard's evidence.
 * With the supervisor in front of it, this is what turns that into a single
 * failed test: the spec that was running when the runtime died still fails,
 * and the next one waits here for the replacement instead of racing it.
 *
 * `/app.js` is a public asset path, so this needs no identity header, and it
 * is served by the loaded artifact — a 200 proves the replacement Worker has
 * its artifact back, not merely that a socket accepts.
 */
async function waitForServer(baseURL: string): Promise<void> {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  let lastFailure = "no attempt was made";
  let attempts = 0;
  for (;;) {
    try {
      const response = await fetch(`${baseURL}/app.js`);
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

export const test = base.extend<E2EOptions & E2EFixtures>({
  ollamaBaseUrl: ["", { option: true }],

  userId: async ({}, use) => {
    await use(`e2e-${crypto.randomUUID()}`);
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

    await use(page);

    // The allow-list is consulted here rather than at capture time, so a test
    // may declare what it expects at any point before it ends.
    const unexpected = problems.filter((problem) => {
      const patterns =
        problem.kind === "console" || problem.kind === "pageerror"
          ? allowedFailures.console
          : allowedFailures.requests;
      return !patterns.some((pattern) => pattern.test(problem.text));
    });
    expect(
      unexpected.map((problem) => `${problem.kind}: ${problem.text}`),
      "the page reported errors no test allowed",
    ).toEqual([]);
  },
});

export { expect } from "@playwright/test";

/** The name every model reaches the UI under, from the fake catalog. */
export const E2E_MODEL_LABEL = "gpt-oss:20b";
export const E2E_CONNECTION_LABEL = "Local Ollama";

/**
 * Open the application as a fresh development identity.
 *
 * `?as_user=` is the gateway's development identity: it answers the request as
 * that user and sets the `frockbot_dev_user` cookie, so every later request in
 * this browser context is the same user without the parameter. On a host that
 * is not loopback the sign-in gate renders instead, and there the local
 * developer identity is offered; the click is conditional so the helper works
 * either way.
 */
export async function openApplication(
  page: Page,
  userId: string,
): Promise<void> {
  await page.goto(`/?as_user=${userId}`);
  const developerSignIn = page.getByRole("button", {
    name: "Continue as local developer",
  });
  if (await developerSignIn.isVisible().catch(() => false)) {
    await developerSignIn.click();
  }
  // Not the "Create Bot" button: for a User with no Bots the creation dialog
  // opens by itself, and its submit carries the same name. The sidebar's
  // Connectors trigger renders once the shell has mounted and read the manifest.
  //
  // On a phone the sidebar is a closed drawer — inert, and so invisible to a
  // role query — and the menu button that opens it is the same signal: it too
  // renders only once the shell has mounted.
  await expect(
    page
      .getByRole("button", { name: "Connectors", exact: true })
      .or(page.getByRole("button", { name: "Show navigation" })),
  ).toBeVisible();
}

/** The Bot creation dialog opens by itself for a User with no Bots. */
export function firstRunDialog(page: Page): Locator {
  return page.getByRole("dialog");
}

/** Create a Bot through the flock dialog. */
export async function createBot(page: Page, name: string): Promise<void> {
  const dialog = firstRunDialog(page);
  // Two states have to converge here: for a User with no Bots the dialog opens
  // by itself, and while it is opening its backdrop swallows a click on the
  // sidebar trigger. Retrying the decision rather than sampling it once makes
  // the helper correct whichever state the shell settles into.
  await expect(async () => {
    if (await dialog.isVisible()) return;
    // The sidebar trigger is an icon button, so it is the one with a title —
    // and on a phone it is behind the drawer.
    await revealSidebar(page);
    await page.getByTitle("Create Bot").click({ timeout: 2_000 });
    await expect(dialog).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await expect(dialog).toBeVisible();
  // And the name has to stick. A User with no Bots gets the dialog opened for
  // them at the end of every flock load, and a load that lands while the name
  // is being typed reopens the dialog on an empty draft — the field clears,
  // the required input refuses to submit, and the dialog never closes. Retry
  // until the value survives, which is also what a person would do.
  // The same reopen also lands between the value settling and the submit, and
  // then the click meets an empty draft: the required input refuses, and the
  // dialog stays open for the rest of the run. So the fill and the submit
  // retry together. A reopened draft submits nothing, so a retry cannot leave
  // a second Bot behind.
  const nameField = dialog.getByLabel("Bot name");
  await expect(async () => {
    if (await dialog.isHidden()) return;
    await nameField.fill(name);
    await expect(nameField).toHaveValue(name, { timeout: 2_000 });
    await dialog.getByRole("button", { name: "Create Bot" }).click();
    await expect(dialog).toBeHidden({ timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
  await expect(dialog).toBeHidden();
}

/**
 * Make the sidebar reachable, whatever the layout.
 *
 * Below the phone breakpoint the sidebar is a drawer that closes behind
 * whatever it opened, so a helper that clicks something inside it has to open
 * it first — and a helper that clicks two things, on two surfaces, has to open
 * it twice. At desktop widths there is no menu button and this does nothing,
 * which is what lets every helper below call it unconditionally.
 */
export async function revealSidebar(page: Page): Promise<void> {
  const menu = page.getByRole("button", { name: "Show navigation" });
  if (!(await menu.isVisible().catch(() => false))) return;
  await menu.click();
  await expect(page.locator(".sidebar")).toBeVisible();
}

/** Open the Plugins overlay and wait for its heading. */
export async function openPlugins(page: Page): Promise<void> {
  await revealSidebar(page);
  await page.locator(".profile-trigger").click();
  await page.getByRole("menuitem", { name: "Plugins", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Plugins" })).toBeVisible();
}

/** Open the Models overlay and wait for its heading. */
export async function openModels(page: Page): Promise<void> {
  await revealSidebar(page);
  await page.locator("button.profile-trigger").click();
  await page.getByRole("menuitem", { name: "Models", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Models" })).toBeVisible();
}

/**
 * The Ollama Cloud card on the Models surface, where a model provider's
 * accounts live. Plugins holds the same Package's enablement row and none of
 * its configuration.
 */
export function ollamaCard(page: Page): Locator {
  return page.locator("article.provider-card", {
    has: page.getByText("Ollama Cloud", { exact: true }),
  });
}

/** The Ollama Cloud enablement row in Plugins. */
export function ollamaPluginRow(page: Page): Locator {
  return page.locator("article.plugin-card", {
    has: page.getByText("Ollama Cloud", { exact: true }),
  });
}

/** The Custom models enablement row in Plugins. */
export function customModelsPluginRow(page: Page): Locator {
  return page.locator("article.plugin-card", {
    has: page.getByText("Custom models", { exact: true }),
  });
}

/**
 * Switch a Package on from its Plugins row, whichever affordance it offers,
 * and wait until the row reports it is on. Enabling is refused while a
 * declared dependency is off, so a caller that skips a dependency would
 * otherwise sail past the refusal and wait out its timeout on a surface that
 * never appears.
 */
async function enablePluginRow(row: Locator): Promise<void> {
  await expect(row).toBeVisible();
  const action = row.getByRole("button", { name: /^(Add|Enable)$/u });
  await expect(action).toBeVisible();
  await action.click();
  await expect(
    row.getByRole("button", { name: "Disable", exact: true }),
  ).toBeVisible();
}

/**
 * Switch Custom models on. The platform chooses the model, so choosing one at
 * all — and every model provider besides the built-in one — is behind this one
 * Package, which ships disabled.
 */
export async function enableCustomModels(page: Page): Promise<void> {
  await openPlugins(page);
  await enablePluginRow(customModelsPluginRow(page));
  await closeOverlay(page);
}

/**
 * Enable the Ollama Cloud Package if it is not already, then connect an API
 * key to an endpoint on Models.
 *
 * Three steps, three surfaces on purpose: Custom models decides whether a User
 * chooses models at all, Plugins decides whether this provider is on, and
 * Models sets it up. Ollama Cloud declares a dependency on Custom models, so
 * enabling it first is the shipped path, not test scaffolding. `API base URL`
 * is the Package's own Connection setting, so pointing the Connection at the
 * harness's fake server is also the shipped path a User takes to reach a local
 * Ollama. It leaves the form submitted; the caller decides whether it expects
 * success or a failure.
 */
export async function connectOllama(
  page: Page,
  options: { apiKey: string; apiBaseUrl: string; label?: string },
): Promise<void> {
  await enableCustomModels(page);
  await openPlugins(page);
  await enablePluginRow(ollamaPluginRow(page));
  await closeOverlay(page);
  await openModels(page);
  const card = ollamaCard(page);
  await card.getByRole("button", { name: "Connect", exact: true }).click();
  await page
    .getByLabel("Connection label")
    .fill(options.label ?? E2E_CONNECTION_LABEL);
  await page.getByLabel("API key").fill(options.apiKey);
  await page.getByLabel("API base URL").fill(options.apiBaseUrl);
  await page.getByRole("button", { name: "Connect account" }).click();
}

/** Close whichever overlay surface is open. */
export async function closeOverlay(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Close panel" }).click();
}

/**
 * Choose the default model every new Bot starts on, on Models — the surface
 * that owns both the provider's accounts and the choice made from them.
 *
 * The surface reads its stored selection in `onMounted`, after an awaited
 * catalog load, so a selection made before that resolves is overwritten.
 * Waiting for the option to exist waits for exactly that moment: the options
 * come from the same load.
 */
export async function chooseDefaultModel(
  page: Page,
  optionLabel: string,
): Promise<void> {
  await openModels(page);
  const models = page.getByLabel(/^Account model/);
  await expect(
    models.getByRole("option", { name: optionLabel }),
  ).toBeAttached();
  await models.selectOption({ label: optionLabel });
  await page.getByRole("button", { name: "Save account model" }).click();
  await closeOverlay(page);
  await expect(page.getByRole("heading", { name: "Models" })).toBeHidden();
}

/**
 * The whole provisioning path a User walks before a first conversation:
 * connect a provider, choose the default model, create the Bot. Every step is
 * a click a person makes, so the specs that need a working Bot prove the path
 * as a side effect of using it.
 */
export async function provisionThroughUi(
  page: Page,
  options: {
    userId: string;
    apiKey: string;
    apiBaseUrl: string;
    botName: string;
  },
): Promise<void> {
  await openApplication(page, options.userId);
  await firstRunDialog(page).getByRole("button", { name: "Cancel" }).click();
  await connectOllama(page, {
    apiKey: options.apiKey,
    apiBaseUrl: options.apiBaseUrl,
  });
  await expect(
    ollamaCard(page).getByText("ready · models fresh"),
  ).toBeVisible();
  await closeOverlay(page);
  await chooseDefaultModel(
    page,
    `${E2E_MODEL_LABEL} — ${E2E_CONNECTION_LABEL}`,
  );
  await createBot(page, options.botName);
  // The empty-thread heading is the shell's own "this Bot has a usable model"
  // signal. Waiting for it, and not only for an enabled composer, avoids
  // typing into a composer that is about to be re-rendered under the draft.
  await expect(
    page.getByRole("heading", { name: `${options.botName} is ready.` }),
  ).toBeVisible();
  await expect(composerInput(page)).toBeEnabled();
}

/**
 * The message composer. Matched by its accessible name rather than by role:
 * the Skill popover makes it a `combobox`, and which widget role the composer
 * carries is not what any spec is about.
 */
export function composerInput(page: Page): Locator {
  return page.getByLabel("Message", { exact: true });
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
export function assistantMessages(page: Page): Locator {
  return page.locator("article.message-assistant");
}

export async function sendMessage(
  page: Page,
  text: string,
  // How many messages the Bot is expected to send back. A Turn is not one
  // bubble: the Bot acknowledges, works, and reports back, and each of those
  // is its own message, so a caller scripting several sends says how many to
  // wait for.
  options: { replies?: number } = {},
): Promise<void> {
  const composer = composerInput(page);
  const send = page.getByRole("button", { name: "Send message" });
  // Counted before the send, because "settled" means one *more* reply than the
  // thread already had. The Stop button is not that signal: it is absent for a
  // moment right after a send too, before the client has observed its own run,
  // so waiting on its absence returned while the Turn was still starting — and
  // the next `sendMessage` then raced the Turn it was supposed to follow.
  const replies = assistantMessages(page);
  const before = await replies.count();
  await composer.fill(text);
  await expect(composer).toHaveValue(text);
  await send.click();
  await expect(composer).toHaveValue("", { timeout: 120_000 });
  // The Turn is durable now, so the message is in the thread the client reads
  // back rather than only in the composer that submitted it.
  await expect(page.locator("main").getByText(text)).toBeVisible({
    timeout: 120_000,
  });
  // There is no SSE: the client POSTs the Turn and polls the run. The Turn has
  // settled when its own reply exists and has stopped streaming.
  await expect(replies).toHaveCount(before + (options.replies ?? 1), {
    timeout: 120_000,
  });
  await expect(replies.last().locator(".bot-avatar-live")).toHaveCount(0, {
    timeout: 120_000,
  });
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
