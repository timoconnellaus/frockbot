// The Applets shell: a declarative entry, the surface it opens, and the canvas
// in both of its states, at the desktop size and at 390px.
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
// listens for that `init` rather than for a Package state feed — the list page
// beside it is a Package page, and does.
import { PACKAGE_IFRAME_HELPER_JS_V1 } from "@frockbot/core/contracts";
import type { Locator, Page, TestInfo } from "@playwright/test";
import {
  test,
  expect,
  action,
  closeOverlay,
  connectOllama,
  chooseDefaultModel,
  createBot,
  expectReadyToSend,
  group,
  openApplication,
  openPlugins,
  press,
  sem,
  E2E_CONNECTION_LABEL,
  E2E_MODEL_LABEL,
} from "./fixtures.ts";
import { E2E_OLLAMA_GOOD_API_KEY } from "./harness.ts";

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
  return `<!doctype html>
<html><body><h1 id="heading">Your Applets</h1><output id="list">waiting</output>
<button id="focus" type="button">Open Todo</button>
<script>${PACKAGE_IFRAME_HELPER_JS_V1}</script>
<script>
window.frockbot.ready.then(() => {
  window.frockbot.subscribe('applets', value => {
    document.getElementById('list').textContent =
      'applets:' + value.list.map(a => a.displayName).join(',');
  });
  document.getElementById('focus').addEventListener('click', () => {
    window.frockbot.focus('${APPLET_ID}');
  });
  window.frockbot.resize(160);
});
</script></body></html>`;
}

/**
 * The live Applet's own page. It is handed one message — the `init` carrying
 * the viewer credential and the generation it names — and nothing else, so
 * what it can say is which generation reached it.
 */
function appletPageHtml(): string {
  return `<!doctype html>
<html><body><output id="view">waiting</output>
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
  let focused: string | null = APPLET_ID;

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
      body: JSON.stringify({ schemaVersion: 1, applets: [summary()] }),
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
async function enablePackage(page: Page, title: string): Promise<void> {
  await openPlugins(page);
  const row = group(page, title);
  await press(action(row, "set-package-enabled"));
  await expect(row.getByText("Turn off")).toBeVisible({ timeout: 30_000 });
  await closeOverlay(page);
}

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
  const canvas = sem(page, "applet-canvas");
  await expect(canvas).toBeVisible({ timeout: 60_000 });
  return canvas;
}

test("a Package entry opens its surface and a focused Applet fills the canvas", async ({
  page,
  userId,
  ollamaBaseUrl,
  baseURL,
  allowedFailures,
}, testInfo) => {
  // An Applet with nothing published has no live page, and the route says so
  // with a 404 the canvas reads as its building state. The browser logs it
  // either way.
  allowedFailures.requests.push(/\/api\/applets\/[^/]+\/ui$/u);
  allowedFailures.console.push(/Failed to load resource.*404/u);
  const stubs = await installAppletRoutes(page, testInfo, baseURL);
  await provision(page, {
    userId,
    apiBaseUrl: ollamaBaseUrl,
    botName: "Builder",
  });
  await page.setViewportSize(DESKTOP);

  // The entry is a manifest declaration: a control in the Bot's header, named
  // by the Package and the entry it declared, with no code of the Package's
  // running in the app origin.
  const entry = sem(page, `package-entry-${PACKAGE_ID}-open`);
  await expect(entry).toBeVisible({ timeout: 60_000 });

  // The canvas opens on this Session's focused Applet, in its building state:
  // the source the Bot has written so far, and what the work has got to.
  const canvas = await openCanvas(page);
  await expect(named(canvas, "Todo")).toBeVisible();
  const progress = sem(page, "applet-canvas-progress");
  await expect(progress).toBeVisible();
  await expect(progress).toContainText("The code checks out");
  // The code view opens on the most recently changed file, and moves to
  // whichever one is pressed.
  await expect(fileState(page, "ui.tsx")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await press(openFile(page, "server.ts"));
  await expect(fileState(page, "server.ts")).toHaveAttribute(
    "aria-checked",
    "true",
  );

  // The entry's surface hosts the Package's list page, and the page is fed the
  // Applets state over bridge v2. Applets ships with the product, so the frame
  // says nothing about where the page came from: an attribution line is for a
  // page somebody else wrote.
  await press(entry);
  const surface = sem(page, `package-page-${PACKAGE_ID}-list`);
  await expect(surface).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Built by this Bot")).toHaveCount(0);
  // The page itself, by the name the host frames it under. A framed page is a
  // platform view: the engine puts its iframe in the scene rather than inside
  // the semantics node the surface is named by, so it is reached from the page
  // rather than from that node.
  const listFrame = page.frameLocator('iframe[title="Applets"]');
  await expect(listFrame.getByText("applets:Todo")).toBeVisible({
    timeout: 30_000,
  });
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("applets-desktop.png") });

  // A publish lands, and the page's own `focus` message re-reads the Applet:
  // the ready state slides the live Applet in over the code view.
  stubs.publish();
  await listFrame.getByRole("button", { name: "Open Todo" }).click();
  // The surface is a page of its own, so the way back to the canvas is the way
  // back — the shell has no scrim here to click through.
  await page.goBack();
  await expect(canvas).toBeVisible();

  // The header names the live generation in words. The exact id is not on the
  // page at all — it is an internal identifier, and the Applet the frame loads
  // is what proves the right generation went live.
  await expect(named(canvas, "Todo")).toHaveAttribute("aria-label", /Live/u);
  // And the building view is gone: there is a running Applet to look at.
  await expect(sem(page, "applet-canvas-progress")).toHaveCount(0);
  const appFrame = page.frameLocator('iframe[title="Applet"]');
  await expect(appFrame.getByText("live:generation-2")).toBeVisible({
    timeout: 30_000,
  });

  // The toggle goes back to the code without reloading the Applet.
  await sem(page, "applet-canvas-tabs").getByText("Code").click();
  await expect(fileState(page, "server.ts")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await sem(page, "applet-canvas-tabs").getByText("App").click();
  await expect(appFrame.getByText("live:generation-2")).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("applets-ready.png") });
});

test("the canvas is a full-height sheet on a phone with a composer chip", async ({
  page,
  userId,
  ollamaBaseUrl,
  baseURL,
  allowedFailures,
}, testInfo) => {
  allowedFailures.requests.push(/\/api\/applets\/[^/]+\/ui$/u);
  allowedFailures.console.push(/Failed to load resource.*404/u);
  await installAppletRoutes(page, testInfo, baseURL);
  await provision(page, {
    userId,
    apiBaseUrl: ollamaBaseUrl,
    botName: "Builder",
  });
  await page.setViewportSize(PHONE);

  // On a phone nothing opens itself: the focused Applet is a control in the
  // header rather than a screen the User did not ask for.
  const chip = sem(page, "applet-chip");
  await expect(chip).toBeVisible({ timeout: 60_000 });
  await expect(sem(page, "applet-canvas")).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath("applets-phone-chip.png"),
  });

  const canvas = await openCanvas(page);
  const box = await canvas.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(PHONE.width - 24);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("applets-phone.png") });

  // And the way out gives the conversation back.
  await press(sem(page, "applet-canvas-close"));
  await expect(sem(page, "applet-canvas")).toHaveCount(0);
  await expect(chip).toBeVisible();
});
