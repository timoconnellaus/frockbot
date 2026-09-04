// The Applets shell: a declarative entry, the surface it opens, and the canvas
// in both of its states, at the desktop size and at 390px.
//
// The Applet authority is a parallel lane, so its routes are stubbed here the
// way the fake AI service is stubbed elsewhere: everything that hosts, orders,
// focuses, and draws is the production client bundle, and only what the
// backend has not landed yet is faked. When those routes arrive the stubs come
// out and nothing in the assertions changes.
import { PACKAGE_IFRAME_HELPER_JS_V1 } from "@frockbot/kernel-contracts";
import type { Page, TestInfo } from "@playwright/test";
import { test, expect, provisionThroughUi } from "./fixtures.ts";
import { E2E_OLLAMA_GOOD_API_KEY } from "./harness.ts";

const LIST_HASH = "b".repeat(64);
const CANVAS_HASH = "c".repeat(64);
const PACKAGE_ID = "applets";
const APPLET_ID = "u1abc.todo";
const PHONE = { width: 390, height: 844 } as const;

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

function canvasPageHtml(): string {
  return `<!doctype html>
<html><body><output id="view">waiting</output>
<script>${PACKAGE_IFRAME_HELPER_JS_V1}</script>
<script>
window.frockbot.ready.then(() => {
  window.frockbot.subscribe('applets', value => {
    document.getElementById('view').textContent = value.viewer
      ? 'live:' + value.viewer.generationId
      : 'no-generation';
  });
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
): Promise<AppletStubs> {
  const port = process.env.FROCKBOT_E2E_PORT;
  if (!port) throw new Error("the E2E app port is unavailable");
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
        generationId: "generation-ui",
        artifactOrigin,
        contributions: [
          {
            packageId: PACKAGE_ID,
            displayName: "Applets",
            provenance: "Bot-authored",
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
              {
                id: "canvas",
                artifact: {
                  contentHash: CANVAS_HASH,
                  size: new TextEncoder().encode(canvasPageHtml()).byteLength,
                  mediaType: "text/html",
                  bundlerVersion: "frockbot-inline-html@1",
                },
                mounts: [{ slot: "frockbot.right-panel" }],
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
      body: canvasPageHtml(),
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
  await page.route(/\/api\/applets\/[^/]+\/ui$/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        uiUrl: `${artifactOrigin}/packages/${CANVAS_HASH}.html`,
        generationId: "generation-2",
      }),
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

test("a Package entry opens its surface and a focused Applet fills the canvas", async ({
  page,
  userId,
  ollamaBaseUrl,
}, testInfo) => {
  const stubs = await installAppletRoutes(page, testInfo);
  await provisionThroughUi(page, {
    userId,
    apiKey: E2E_OLLAMA_GOOD_API_KEY,
    apiBaseUrl: ollamaBaseUrl,
    botName: "Builder",
  });

  // The entry is declared at order 5 and Connectors registers at 10, so the
  // entry draws above it.
  const entry = page.getByRole("button", { name: "Applets", exact: true });
  const connectors = page.getByRole("button", { name: "Connectors" });
  await expect(entry).toBeVisible();
  const entryBox = await entry.boundingBox();
  const connectorsBox = await connectors.boundingBox();
  expect(entryBox?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(
    connectorsBox?.y ?? 0,
  );

  // The canvas is already up, because this Session has a focused Applet: its
  // building state, with the source the Bot has written so far.
  const canvas = page.getByRole("region", { name: "Applet Todo" });
  await expect(canvas).toBeVisible();
  await expect(canvas.getByText("Todo", { exact: true })).toBeVisible();
  // The building view: what the Bot has got to, in words, rather than one
  // fixed line about the Applet not being live.
  const progress = canvas.getByTestId("applet-canvas-progress");
  await expect(progress).toBeVisible();
  await expect(progress.getByText("The code checks out")).toBeVisible();
  // The code view opens on the most recently changed file.
  await expect(canvas.getByText("export default function App()")).toBeVisible();
  await canvas.getByRole("button", { name: "server.ts" }).click();
  await expect(canvas.getByText("export class TodoApplet")).toBeVisible();

  // The entry's surface hosts the Package's list page, attributed to it, and
  // the page is fed the Applets state over bridge v2.
  await entry.click();
  const surface = page.getByRole("region", { name: "Applets" });
  await expect(surface.getByText("Built by this Bot")).toBeVisible();
  const listFrame = surface.locator("iframe").contentFrame();
  await expect(listFrame.getByText("applets:Todo")).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("applets-desktop.png") });

  // A publish lands, and the page's own `focus` message re-reads the Applet:
  // the ready state slides the live Applet in over the code view.
  stubs.publish();
  await listFrame.getByRole("button", { name: "Open Todo" }).click();
  await surface.page().keyboard.press("Escape");
  // The header names the live generation in words. The exact id is not on the
  // page at all — it is an internal identifier, and the Applet the frame loads
  // is what proves the right generation went live.
  await expect(canvas.getByText(/^Live/)).toBeVisible();
  // And the building view is gone: there is a running Applet to look at.
  await expect(canvas.getByTestId("applet-canvas-progress")).toHaveCount(0);
  const appFrame = canvas.locator(".applet-canvas-app iframe").contentFrame();
  await expect(appFrame.getByText("live:generation-2")).toBeVisible();

  // The toggle goes back to the code without reloading the Applet.
  await canvas.getByRole("tab", { name: "Code" }).click();
  await expect(canvas.getByText("export class TodoApplet")).toBeVisible();
  await canvas.getByRole("tab", { name: "App" }).click();
  await expect(appFrame.getByText("live:generation-2")).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("applets-ready.png") });
});

test("the canvas is a full-height sheet on a phone with a composer chip", async ({
  page,
  userId,
  ollamaBaseUrl,
}, testInfo) => {
  await installAppletRoutes(page, testInfo);
  await page.setViewportSize(PHONE);
  await provisionThroughUi(page, {
    userId,
    apiKey: E2E_OLLAMA_GOOD_API_KEY,
    apiBaseUrl: ollamaBaseUrl,
    botName: "Builder",
  });

  // On a phone the panel starts closed, so the focused Applet is a chip on the
  // composer rather than a screen the User did not ask for.
  const chip = page.getByRole("button", { name: /Applet: Todo/ });
  await expect(chip).toBeVisible();
  // The chip carries the line the canvas would have carried, so the phone and
  // a wide screen tell the same story without opening anything.
  await expect(chip.getByText("The code checks out")).toBeVisible();
  await expect(page.getByRole("region", { name: "Applet Todo" })).toBeHidden();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath("applets-phone-chip.png"),
  });

  await chip.click();
  const canvas = page.getByRole("region", { name: "Applet Todo" });
  await expect(canvas).toBeVisible();
  const canvasBox = await canvas.boundingBox();
  expect(canvasBox?.width ?? 0).toBeGreaterThan(PHONE.width - 24);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("applets-phone.png") });

  // Escape gives the conversation back, the same thing the scrim does.
  await page.keyboard.press("Escape");
  await expect(chip).toBeVisible();
});
