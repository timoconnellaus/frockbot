// A Plugin's own page in the conversation panel (ADR 0036), docked at desktop
// width, as a drawer over the conversation, and at phone width. The panel read, the tool route and the stored page are
// intercepted — this suite has no build service to publish a real one — but
// the page is answered with the Worker's own policy, sandbox and all, and
// everything that hosts and talks to it is the production client: the canvas,
// the sandboxed frame, and the bridge the page's bytes carry.
import { withPluginPageBridgeV1 } from "@frockbot/core/contracts";
import { PLUGIN_PAGE_CSP_V1 } from "../src/plugin-page-route.ts";
import type { Locator, Page, TestInfo } from "@playwright/test";
import {
  test,
  expect,
  createBot,
  expectNoHorizontalOverflow,
  openApplication,
  openBotPage,
  press,
  sem,
} from "./fixtures.ts";

const CONTENT_HASH = "c".repeat(64);
const PLUGIN_ID = "score";
const DESKTOP = { width: 1351, height: 831 } as const;
const DRAWER = { width: 960, height: 540 } as const;
const PHONE = { width: 390, height: 844 } as const;

/** What the Bot's Plugin stored, as its view hands it to the page. */
function pageHtml(): string {
  return withPluginPageBridgeV1(`<!doctype html>
<html><head><title>Score</title></head><body>
<output id="score">waiting</output><button id="add">Add one</button>
<output id="said">quiet</output>
<script>
const show = (state) => {
  document.getElementById('score').textContent = 'score:' + state.score;
};
frockbot.ready.then(({ state }) => show(state));
frockbot.onState(show);
document.getElementById('add').onclick = async () => {
  document.getElementById('said').textContent = await frockbot.callTool('score_add', { by: 1 });
};
</script></body></html>`);
}

async function installPanelRoutes(
  page: Page,
  testInfo: TestInfo,
  baseURL: string | undefined,
): Promise<{ toolCommands: Record<string, unknown>[] }> {
  // Pages are served from the app's own origin, under `/plugin-pages/`.
  const appOrigin = new URL(baseURL ?? "http://127.0.0.1:8787").origin;
  const toolCommands: Record<string, unknown>[] = [];
  let score = 1;
  let focused = false;

  await page.route(
    /\/api\/bots\/[^/]+\/(panels\/open|panels\/focus|plugins)$/,
    async (route) => {
      const url = new URL(route.request().url());
      const botId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
      // General opens by itself before the spec's own Bot exists; only the
      // Scored Bot runs the Plugin.
      const runs = botId.startsWith("scored-");
      if (url.pathname.endsWith("/plugins")) {
        // The Plugins list is a GET on the same path: only a page's tool call
        // is the spec's to answer.
        const command =
          route.request().method() === "POST"
            ? (route.request().postDataJSON() as Record<string, unknown> | null)
            : null;
        if (command?.kind !== "plugin-tool") return route.fallback();
        toolCommands.push(command);
        score += 1;
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            status: "ran",
            content: `added, now ${score}`,
            isError: false,
          }),
        });
        return;
      }
      if (url.pathname.endsWith("/panels/focus")) {
        focused = true;
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ status: "applied" }),
        });
        return;
      }
      const tab = {
        pluginId: PLUGIN_ID,
        displayName: "Score",
        surfaceId: PLUGIN_ID,
        label: "Score",
      };
      await route.fulfill({
        contentType: "application/json",
        headers: { "cache-control": "no-store" },
        body: JSON.stringify(
          !runs
            ? {
                schemaVersion: 1,
                bag: [],
                focus: { pluginId: null },
                doors: [],
              }
            : {
                schemaVersion: 1,
                bag: [tab],
                focus: focused
                  ? { pluginId: PLUGIN_ID, surfaceId: PLUGIN_ID }
                  : { pluginId: null },
                ...(focused
                  ? {
                      page: {
                        url: `${appOrigin}/plugin-pages/${CONTENT_HASH}.html`,
                        state: { score },
                      },
                    }
                  : {}),
                doors: [
                  {
                    pluginId: PLUGIN_ID,
                    label: "Score",
                    opens: { pluginId: PLUGIN_ID, surfaceId: PLUGIN_ID },
                  },
                ],
              },
        ),
      });
    },
  );
  await page.route(
    `${appOrigin}/plugin-pages/${CONTENT_HASH}.html`,
    async (route) => {
      await route.fulfill({
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": PLUGIN_PAGE_CSP_V1,
          "x-content-type-options": "nosniff",
          "cache-control": "public, max-age=31536000, immutable, no-transform",
        },
        body: pageHtml(),
      });
    },
  );
  testInfo.annotations.push({
    type: "plugin-page-origin",
    description: appOrigin,
  });
  return { toolCommands };
}

/** The frame the host titles with the tab's label. */
function pageFrame(page: Page): Locator {
  return page.locator('iframe[title="Score"]').last();
}

test("a Plugin's own page runs in the conversation panel docked, in a drawer and on a phone", async ({
  page,
  userId,
  baseURL,
}, testInfo) => {
  const { toolCommands } = await installPanelRoutes(page, testInfo, baseURL);
  await page.setViewportSize(DESKTOP);
  await openApplication(page, userId);
  await createBot(page, "Scored");

  // The host draws the door; pressing it focuses the page.
  await openBotPage(page);
  await press(sem(page, `bot-page-panel-${PLUGIN_ID}`));
  await expect(sem(page, "conversation-panel-page")).toBeVisible({
    timeout: 60_000,
  });

  const frame = pageFrame(page);
  // Untrusted, and held to it: an opaque origin with scripts and nothing else.
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  await expect(frame).toHaveAttribute("credentialless", "");
  const content = frame.contentFrame();
  // The page said hello and the host answered with the view's state.
  await expect(content.getByText("score:1", { exact: true })).toBeVisible({
    timeout: 30_000,
  });

  // A tool the page calls is run by the host, on the person's session, and
  // the page hears both its answer and the state the call left behind —
  // without the document being loaded again.
  await content.locator("#add").click();
  await expect(
    content.getByText("added, now 2", { exact: true }),
  ).toBeVisible();
  await expect(content.getByText("score:2", { exact: true })).toBeVisible();
  expect(toolCommands).toHaveLength(1);
  expect(toolCommands[0]).toMatchObject({
    schemaVersion: 1,
    kind: "plugin-tool",
    pluginId: PLUGIN_ID,
    tool: "score_add",
    arguments: JSON.stringify({ by: 1 }),
  });
  await expectNoHorizontalOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath("plugin-page-desktop.png"),
  });

  // The drawer: the panel slides over a dimmed conversation, and a click
  // inside the page is the page's, not the scrim's Close beside it.
  await page.setViewportSize(DRAWER);
  const drawn = pageFrame(page).contentFrame();
  await expect(drawn.getByText("score:2", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await drawn.locator("#add").click();
  await expect(drawn.getByText("score:3", { exact: true })).toBeVisible();
  expect(toolCommands).toHaveLength(2);
  await expect(sem(page, "conversation-panel-page")).toBeVisible();

  // The phone: the panel is its own page, and the Plugin's page is in it.
  await page.setViewportSize(PHONE);
  await openBotPage(page);
  await press(sem(page, `bot-page-panel-${PLUGIN_ID}`));
  await expect(
    pageFrame(page).contentFrame().getByText("score:3", { exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await expectNoHorizontalOverflow(page);
  // The panel's page slides in, and its frame's content can be visible before
  // the slide ends: only where the frame comes to rest is the claim.
  await expect(async () => {
    const box = await pageFrame(page).boundingBox();
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect(
      (box?.x ?? 0) + (box?.width ?? Number.POSITIVE_INFINITY),
    ).toBeLessThanOrEqual(PHONE.width);
  }).toPass({ timeout: 5_000 });
  await page.screenshot({ path: testInfo.outputPath("plugin-page-phone.png") });
});
