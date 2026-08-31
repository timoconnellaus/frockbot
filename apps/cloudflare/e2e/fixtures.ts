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

export interface E2EOptions {
  /** The fake Ollama server the harness started, for `apiBaseUrl`. */
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

  page: async ({ page, allowedFailures }, use) => {
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
      problems.push({
        kind: "requestfailed",
        text: `${request.url()}: ${request.failure()?.errorText ?? "failed"}`,
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
  // Plugins trigger renders once the shell has mounted and read the manifest.
  await expect(
    page.getByRole("button", { name: "Plugins", exact: true }),
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
    // The sidebar trigger is an icon button, so it is the one with a title.
    await page.getByTitle("Create Bot").click({ timeout: 2_000 });
    await expect(dialog).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Bot name").fill(name);
  await dialog.getByRole("button", { name: "Create Bot" }).click();
  await expect(dialog).toBeHidden();
}

/** Open the Plugins overlay and wait for its heading. */
export async function openPlugins(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Plugins" })).toBeVisible();
}

/** The Ollama Cloud card in the Plugins overlay, in either of its two shapes. */
export function ollamaCard(page: Page): Locator {
  return page.locator("article.plugin-card", {
    has: page.getByText("Ollama Cloud", { exact: true }),
  });
}

/**
 * Install the Ollama Cloud Package and connect an API key to an endpoint.
 *
 * `API base URL` is the Package's own Connection setting, so pointing the
 * Connection at the harness's fake server is the shipped path a User takes to
 * reach a local Ollama — not a test-only door. It leaves the form submitted;
 * the caller decides whether it expects success or a failure.
 */
export async function connectOllama(
  page: Page,
  options: { apiKey: string; apiBaseUrl: string; label?: string },
): Promise<void> {
  await openPlugins(page);
  const card = ollamaCard(page);
  const install = card.getByRole("button", { name: "Add", exact: true });
  if (await install.isVisible().catch(() => false)) await install.click();
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
 * Choose the default model every new Bot starts on.
 *
 * The surface fills its own fields in `onMounted`, after two awaited loads, so
 * a selection made before that resolves is overwritten. Waiting for the name
 * field to carry the stored profile name is waiting for exactly that moment.
 */
export async function chooseDefaultModel(
  page: Page,
  optionLabel: string,
): Promise<void> {
  await page.getByRole("button", { name: "FrockBot user" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await expect(
    page.getByRole("heading", { name: "Application settings" }),
  ).toBeVisible();
  await expect(page.getByLabel("Name", { exact: true })).not.toHaveValue("");
  await page.getByLabel(/^Default model/).selectOption({ label: optionLabel });
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(
    page.getByRole("heading", { name: "Application settings" }),
  ).toBeHidden();
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
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeEnabled();
}

/** Send a message and wait for the Turn to settle. */
export async function sendMessage(page: Page, text: string): Promise<void> {
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.fill(text);
  await expect(composer).toHaveValue(text);
  await page.getByRole("button", { name: "Send message" }).click();
  // There is no SSE: the client POSTs the Turn and polls the run. A settled
  // Turn is one with no stop control left on screen.
  await expect(
    page.getByRole("button", { name: "Stop generating" }),
  ).toHaveCount(0, { timeout: 60_000 });
}

/** Point the fake provider at a chat mode; `unauthorized` revokes the key. */
export async function setFakeOllamaChatMode(
  page: Page,
  ollamaBaseUrl: string,
  mode: "ok" | "unauthorized",
): Promise<void> {
  const response = await page.request.post(`${ollamaBaseUrl}/__e2e/chat-mode`, {
    data: { mode },
  });
  expect(response.ok(), "the fake Ollama server accepted the mode").toBe(true);
}
