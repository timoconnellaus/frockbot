// The Applets shell: one native picker and a full-window canvas, in both
// states, at desktop size and at 390px.
//
// The Applet routes are stubbed here the way the fake AI service is stubbed
// elsewhere, and for one reason: the ready state. An Applet only goes live
// after a real container build (`applets-publish.e2e.ts` pays for exactly one
// of those), so a Turn cannot get this spec to a published generation — while
// everything that hosts, orders, focuses and draws is the production client.
// `applets.e2e.ts` is the other half: the same shell with nothing stubbed,
// against the building state a Bot can actually reach.
//
// The canvas is not a Package page. On the web the shell frames the Applet's
// own `uiUrl` and posts it the viewer credential, so the page under test here
// listens for that `init` rather than for a Package state feed.
import type { Locator, Page, TestInfo } from "@playwright/test";
import {
  test,
  expect,
  connectOllama,
  chooseDefaultModel,
  createBot,
  enableApplets,
  expectReadyToSend,
  openApplication,
  enablePackage,
  press,
  sem,
  sendMessage,
  E2E_CONNECTION_LABEL,
  E2E_MODEL_LABEL,
} from "./fixtures.ts";
import { E2E_OLLAMA_GOOD_API_KEY, e2eToolCallPrompt } from "./harness.ts";

const LIST_HASH = "b".repeat(64);
const CANVAS_HASH = "c".repeat(64);
const PACKAGE_ID = "applets";
const APPLET_ID = "u1abc.todo";
const PHONE = { width: 390, height: 844 } as const;
const DESKTOP = { width: 1280, height: 800 } as const;

/**
 * The window the Plugins list is turned on from.
 *
 * Tall enough that both rows this spec presses are on screen at once, which is
 * the whole point: a Flutter list paints to a canvas, and steering it by the
 * wheel is not reliable enough to build on — the engine drops a row out of the
 * accessibility tree as the list moves and puts it back a frame or two later,
 * so a scroll can walk past a row that is on screen. Nothing about a Package
 * being turned on is about the size of the window, so the size is chosen to
 * take the scroll out of the path rather than to prove anything.
 */
const PROVISIONING_WINDOW = { width: 1280, height: 1800 } as const;

function listPageHtml(): string {
  return "<!doctype html><html><body><h1>Your Applets</h1></body></html>";
}

/**
 * The live Applet's own page. It is handed one message — the `init` carrying
 * the viewer credential and the generation it names — and nothing else, so
 * what it can say is which generation reached it.
 */
function appletPageHtml(): string {
  return `<!doctype html>
<html><body><output id="view">waiting</output><input aria-label="Applet draft">
<script>
addEventListener('message', (event) => {
  const message = event.data;
  if (message && message.type === 'init' && message.applet) {
    document.getElementById('view').textContent =
      'live:' + message.applet.generationId;
  }
});
</script></body></html>`;
}

interface AppletStubs {
  /** Turns the Applet from a draft into a published one, as a publish would. */
  publish(): void;
  /** Whether the delete route has been asked to remove the Applet. */
  deleted(): boolean;
  focused(): string | null;
}

async function installAppletRoutes(
  page: Page,
  testInfo: TestInfo,
  baseURL: string | undefined,
): Promise<AppletStubs> {
  // The anonymous page origin is a sibling host of the app's, on the same
  // port, so it is derived from where this run is pointed rather than from an
  // environment variable only one of the two configurations sets.
  if (!baseURL) throw new Error("this run has no base URL");
  const port = new URL(baseURL).port;
  const artifactOrigin = `http://ui.localhost:${port}`;
  let published = false;
  let removed = false;
  let focused: string | null = null;

  const summary = () => ({
    appletId: APPLET_ID,
    displayName: "Todo",
    status: published ? "published" : "draft",
    ...(published ? { currentGenerationId: "generation-2" } : {}),
    tools: ["add_todo"],
    createdAt: "2026-09-03T00:00:00.000Z",
  });

  await page.route(/\/api\/bots\/[^/]+\/package-ui$/, async (route) => {
    const url = new URL(route.request().url());
    const botId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 1,
        botId,
        artifactOrigin,
        contributions: [
          {
            packageId: PACKAGE_ID,
            displayName: "Applets",
            provenance: "FrockBot",
            pages: [
              {
                id: "list",
                artifact: {
                  contentHash: LIST_HASH,
                  size: new TextEncoder().encode(listPageHtml()).byteLength,
                  mediaType: "text/html",
                  bundlerVersion: "frockbot-inline-html@1",
                },
                mounts: [{ slot: "frockbot.surface:list" }],
              },
            ],
            entries: [
              {
                id: "open",
                slot: "frockbot.sidebar-actions",
                order: 5,
                label: "Applets",
                icon: "applets",
                opens: { kind: "surface", page: "list" },
              },
            ],
            declaredTools: ["applet_focus", "applet_create"],
          },
        ],
      }),
    });
  });

  await page.route(`${artifactOrigin}/packages/${LIST_HASH}.html`, (route) =>
    route.fulfill({
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: listPageHtml(),
    }),
  );
  await page.route(`${artifactOrigin}/packages/${CANVAS_HASH}.html`, (route) =>
    route.fulfill({
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: appletPageHtml(),
    }),
  );

  await page.route("**/api/applets", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 1,
        applets: removed ? [] : [summary()],
      }),
    }),
  );
  // A delete is permanent: the directory stops listing the Applet, which is
  // the whole of what a person sees afterwards.
  await page.route(/\/api\/applets\/[^/]+\/delete$/, (route) => {
    removed = true;
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ schemaVersion: 1, status: "deleted" }),
    });
  });
  // The canvas's one read: the directory, the focus, and for a published focus
  // the viewer. An unpublished focus is its id alone, which the canvas draws as
  // the building state.
  await page.route(/\/api\/bots\/[^/]+\/applets\/open$/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 1,
        applets: removed ? [] : [summary()],
        ...(focused === null || removed
          ? {}
          : {
              focused: published
                ? {
                    appletId: APPLET_ID,
                    generationId: "generation-2",
                    uiUrl: `${artifactOrigin}/packages/${CANVAS_HASH}.html`,
                    token: "viewer.token",
                    expiresAt: "2099-01-01T00:00:00.000Z",
                    socketUrl: `ws://localhost:${port}/api/applets/${APPLET_ID}/socket`,
                  }
                : { appletId: APPLET_ID },
            }),
      }),
    }),
  );
  await page.route(/\/api\/bots\/[^/]+\/applets\/focus$/, async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as { appletId: unknown };
      focused = typeof body.appletId === "string" ? body.appletId : null;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ appletId: focused }),
    });
  });
  await page.route(/\/api\/bots\/[^/]+\/applets\/[^/]+\/source$/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        appletId: APPLET_ID,
        truncated: false,
        files: [
          {
            path: "server.ts",
            text: "export class TodoApplet extends Applet {}",
            generationId: "w-1",
            changedAt: "2026-09-03T00:01:00.000Z",
          },
          {
            path: "ui.tsx",
            text: "export default function App() { return null }",
            generationId: "w-2",
            changedAt: "2026-09-03T00:05:00.000Z",
          },
        ],
      }),
    }),
  );
  await page.route(/\/api\/bots\/[^/]+\/applets\/[^/]+\/build$/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        status: "passed",
        command: "check",
        at: "2026-09-03T00:06:00.000Z",
        summary: "no diagnostics",
      }),
    }),
  );
  // A draft has no live page, and the route says so with a 404 — which is the
  // building state rather than a failed canvas.
  await page.route(/\/api\/applets\/[^/]+\/ui$/, (route) =>
    published
      ? route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            uiUrl: `${artifactOrigin}/packages/${CANVAS_HASH}.html`,
            generationId: "generation-2",
          }),
        })
      : route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: "not published" }),
        }),
  );
  await page.route(/\/api\/applets\/[^/]+\/token$/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        token: "viewer.token",
        expiresAt: "2099-01-01T00:00:00.000Z",
        socketUrl: `ws://localhost:${port}/api/applets/${APPLET_ID}/socket`,
      }),
    }),
  );

  testInfo.annotations.push({
    type: "applets-origin",
    description: artifactOrigin,
  });
  return {
    publish() {
      published = true;
    },
    deleted() {
      return removed;
    },
    focused() {
      return focused;
    },
  };
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(0);
}

/** Turn a Package on from its Plugins row. */

/**
 * A Bot whose Turns reach the fake provider, by the path a person walks.
 *
 * The same path as `provisionThroughUi`, in a window where the Plugins list
 * needs no scrolling. The caller sets the size its own claims are about
 * afterwards.
 */
async function provision(
  page: Page,
  options: { userId: string; apiBaseUrl: string; botName: string },
): Promise<void> {
  await page.setViewportSize(PROVISIONING_WINDOW);
  await openApplication(page, options.userId);
  await enableApplets(page, options.userId);
  await enablePackage(page, "Custom models");
  await enablePackage(page, "Ollama Cloud");
  await connectOllama(page, {
    apiKey: E2E_OLLAMA_GOOD_API_KEY,
    apiBaseUrl: options.apiBaseUrl,
  });
  await chooseDefaultModel(
    page,
    `${E2E_MODEL_LABEL} · ${E2E_CONNECTION_LABEL}`,
  );
  await createBot(page, options.botName);
  await expectReadyToSend(page);
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

/** The canvas, opened from the header control that is the whole of its entry. */
async function openCanvas(page: Page) {
  await press(sem(page, "applet-chip"));
  await press(
    page.locator('[flt-semantics-identifier^="applet-choice-"]').first(),
  );
  const canvas = sem(page, "applet-canvas");
  await expect(canvas).toBeVisible({ timeout: 60_000 });
  return canvas;
}

test("one Applets picker opens the full-window draft and live canvas", async ({
  page,
  userId,
  ollamaBaseUrl,
  baseURL,
}, testInfo) => {
  const stubs = await installAppletRoutes(page, testInfo, baseURL);
  await provision(page, {
    userId,
    apiBaseUrl: ollamaBaseUrl,
    botName: "Builder",
  });
  await page.setViewportSize(DESKTOP);

  // The Package still declares its entry, but the native picker is the one
  // Applets destination the shell presents.
  await expect(sem(page, "applet-chip")).toHaveCount(1);
  await expect(sem(page, `package-entry-${PACKAGE_ID}-open`)).toHaveCount(0);
  const canvas = await openCanvas(page);
  await expect.poll(() => stubs.focused()).toBe(APPLET_ID);
  await expect(named(canvas, "Todo")).toBeVisible();
  const box = await canvas.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(DESKTOP.width - 24);
  expect(box?.height ?? 0).toBeGreaterThan(DESKTOP.height - 24);
  await expect(sem(page, "shell-conversation")).not.toBeVisible();
  await expect(
    canvas.getByRole("button", { name: "Back", exact: true }),
  ).toHaveCount(1);
  const progress = sem(page, "applet-canvas-progress");
  await expect(progress).toBeVisible();
  await expect(progress).toContainText("The code checks out");
  await expect(sem(page, "applet-canvas-tabs")).toHaveCount(0);
  await expect(fileState(page, "ui.tsx")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await press(openFile(page, "server.ts"));
  await expect(fileState(page, "server.ts")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("applets-desktop.png") });

  // Back returns to the conversation. Selecting the same Applet again reads
  // its newly published generation through the focus/open routes.
  await press(sem(page, "applet-canvas-close"));
  await expect(canvas).toHaveCount(0);
  await expect(sem(page, "shell-conversation")).toBeVisible();
  expect(stubs.focused()).toBe(APPLET_ID);
  stubs.publish();
  await openCanvas(page);
  await expect(named(canvas, "Todo")).toBeVisible();
  await expect(canvas.locator('[aria-label*="Live since"]')).toHaveCount(0);
  await expect(canvas.getByText(/Live since/)).toHaveCount(0);
  await expect(sem(page, "applet-canvas-progress")).toHaveCount(0);
  const appFrame = page.frameLocator('iframe[title="Applet"]').last();
  await expect(appFrame.getByText("live:generation-2")).toBeVisible({
    timeout: 30_000,
  });
  await appFrame
    .getByRole("textbox", { name: "Applet draft" })
    .fill("Keep this draft");

  // There is one icon action. Its name changes to describe the other view;
  // toggling back retains state in the live document.
  const toggle = sem(page, "applet-canvas-tabs");
  await expect(
    canvas.getByRole("button", { name: "Code", exact: true }),
  ).toHaveCount(1);
  await expect(
    canvas.getByRole("button", { name: "App", exact: true }),
  ).toHaveCount(0);
  await press(toggle);
  await expect(openFile(page, "server.ts")).toBeVisible();
  await press(openFile(page, "server.ts"));
  await expect(fileState(page, "server.ts")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(
    canvas.getByRole("button", { name: "App", exact: true }),
  ).toHaveCount(1);
  await expect(
    canvas.getByRole("button", { name: "Code", exact: true }),
  ).toHaveCount(0);
  await press(toggle);
  await expect(appFrame.getByText("live:generation-2")).toBeVisible();
  await expect(
    appFrame.getByRole("textbox", { name: "Applet draft" }),
  ).toHaveValue("Keep this draft");
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("applets-ready.png") });
});

test("the canvas fills a phone window and Back restores the Bot page", async ({
  page,
  userId,
  ollamaBaseUrl,
  baseURL,
}, testInfo) => {
  await installAppletRoutes(page, testInfo, baseURL);
  await provision(page, {
    userId,
    apiBaseUrl: ollamaBaseUrl,
    botName: "Builder",
  });
  await page.setViewportSize(PHONE);

  // On a phone nothing opens itself: the Applets are a row on the Bot's page
  // rather than a screen the User did not ask for, and the Bot's page is one
  // tap from the conversation, on the Bot's name.
  await expect(sem(page, "applet-canvas")).toHaveCount(0);
  await press(sem(page, "bot-panel-toggle"));
  const chip = sem(page, "applet-chip");
  await expect(chip).toBeVisible({ timeout: 60_000 });
  await expectNoHorizontalOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath("applets-phone-chip.png"),
  });

  const canvas = await openCanvas(page);
  const box = await canvas.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(PHONE.width - 24);
  expect(box?.height ?? 0).toBeGreaterThan(PHONE.height - 24);
  await expect(
    canvas.getByRole("button", { name: "Back", exact: true }),
  ).toHaveCount(1);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("applets-phone.png") });

  // And the way out gives the Bot's page back, with the row still on it.
  await press(sem(page, "applet-canvas-close"));
  await expect(sem(page, "applet-canvas")).toHaveCount(0);
  await expect(chip).toBeVisible();
});

test("the Applets button picks one, a Bot embeds one as a live card, and a delete is confirmed", async ({
  page,
  userId,
  ollamaBaseUrl,
  baseURL,
}, testInfo) => {
  const stubs = await installAppletRoutes(page, testInfo, baseURL);
  // The card is a published Applet embedded in the thread, so this spec never
  // sees the draft state the other two are about.
  stubs.publish();
  await provision(page, {
    userId,
    apiBaseUrl: ollamaBaseUrl,
    botName: "Builder",
  });
  await page.setViewportSize(DESKTOP);

  // One Applets control, before Computer and Routines, and what it opens is a
  // choice rather than an Applet: the Bot's Applets, by name.
  const chip = sem(page, "applet-chip");
  await expect(chip).toBeVisible({ timeout: 60_000 });
  await press(chip);
  const choice = page.locator(
    `[flt-semantics-identifier="applet-choice-${APPLET_ID}"]`,
  );
  await expect(choice).toBeVisible({ timeout: 60_000 });
  await page.screenshot({ path: testInfo.outputPath("applets-picker.png") });
  await press(page.getByRole("button", { name: "Close", exact: true }));
  await expect(choice).toHaveCount(0);

  // A Bot embeds the Applet in chat. The card is live in the thread — its own
  // viewer credential, not the Session's focus — so the Applet's page runs
  // inside the conversation.
  await sendMessage(
    page,
    `Here is the todo list.\n${e2eToolCallPrompt("send_to_user", {
      disposition: "finish",
      payload: { type: "applet", appletId: APPLET_ID },
    })}`,
    { replies: 1 },
  );
  const cardFrame = page.frameLocator('iframe[title="Applet"]');
  await expect(cardFrame.getByText("live:generation-2")).toBeVisible({
    timeout: 60_000,
  });
  // Embedding a card leaves the canvas closed: a card is not a focus change.
  await expect(sem(page, "applet-canvas")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("applets-chat-card.png") });

  // Deleting is permanent, so it asks first, and answering no deletes nothing.
  await press(chip);
  await expect(choice).toBeVisible({ timeout: 60_000 });
  await press(page.getByRole("button", { name: "Delete Todo", exact: true }));
  await expect(page.getByText("Delete Todo?", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("applets-confirm.png") });
  await press(page.getByRole("button", { name: "Cancel", exact: true }));
  expect(stubs.deleted()).toBe(false);
  await expect(choice).toBeVisible();

  await press(page.getByRole("button", { name: "Delete Todo", exact: true }));
  await expect(page.getByText("Delete Todo?", { exact: true })).toBeVisible();
  await press(page.getByRole("button", { name: "Delete", exact: true }));
  await expect(choice).toHaveCount(0, { timeout: 60_000 });
  await expect(
    page.getByText("No Applets yet. Ask a Bot to build one.", { exact: true }),
  ).toBeVisible();
  expect(stubs.deleted()).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("applets-deleted.png") });

  // The card that was live is a card for an Applet that no longer exists. Its
  // own refresh is what finds that out, and what it does about it is say so
  // and take the frame down rather than keep a deleted Applet on screen.
  await press(page.getByRole("button", { name: "Close", exact: true }));
  // The card's own words reach the accessibility tree on the container the
  // engine merged them into, so this reads the label rather than a text node.
  await expect(
    page.locator(
      '[aria-label*="This Applet has been deleted or is unavailable."]',
    ),
  ).toBeVisible({ timeout: 90_000 });
  await page.screenshot({ path: testInfo.outputPath("applets-card-gone.png") });
});
