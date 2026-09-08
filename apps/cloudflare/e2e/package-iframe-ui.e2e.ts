// Non-first-party Package UI stays a page, even when the hosted shell is the
// desktop-sized site or the same site at its 390px phone breakpoint. The
// Package projection and immutable object are intercepted because this suite's
// bundler is intentionally absent; everything that hosts and talks to the page
// is the production client.
//
// Under Flutter the host is `view/host_frame_web.dart`: a platform view over a
// real iframe, which is why this is still a browser spec and not an integration
// one. The iframe is a sibling of the semantics tree rather than a child of it
// — a platform view is DOM the engine positions, and the identifiers live in
// the accessibility tree — so the chrome is named by `PackageIds` and the frame
// itself by the title the host gives it, which is the Package's display name.
import { PACKAGE_IFRAME_HELPER_JS_V1 } from "@frockbot/core/contracts";
import type { Locator, Page, TestInfo } from "@playwright/test";
import {
  test,
  expect,
  createBot,
  openApplication,
  press,
  sem,
} from "./fixtures.ts";

const CONTENT_HASH = "a".repeat(64);
const PACKAGE_ID = "weather-card";
const PAGE_ID = "main";
const TOOL_NAME = "weather_lookup";
const DESKTOP = { width: 1351, height: 831 } as const;
const PHONE = { width: 390, height: 844 } as const;

/** The height the page asks the host for, and the only one it ever asks for. */
const REQUESTED_HEIGHT = 180;

function artifactHtml(): string {
  return `<!doctype html>
<html><body><output id="settings">waiting</output><output id="view">waiting</output>
<script>${PACKAGE_IFRAME_HELPER_JS_V1}</script>
<script>
window.frockbot.ready.then(({ slot }) => {
  const view = document.getElementById('view');
  window.frockbot.subscribe('tool:${TOOL_NAME}', value => {
    // What the host feeds back is the Turn the tool ran as, so the page reads
    // its own result out of that Turn's events.
    const result = (value.events || []).find(event => event.type === 'tool/result');
    view.textContent = 'bridge:' + JSON.parse(result.content).temperature;
  });
  window.frockbot.callTool('${TOOL_NAME}', { city: 'Sydney' });
  window.frockbot.resize(${REQUESTED_HEIGHT});
});
</script></body></html>`;
}

async function installPackageRoutes(
  page: Page,
  testInfo: TestInfo,
  baseURL: string | undefined,
): Promise<{ toolCommands: unknown[]; documentLoads: () => number }> {
  // The separate, anonymous serving origin a Package page is fetched from. It
  // is stubbed below, so what matters is only that it is not the app's own
  // origin — which is what the client refuses to accept a page from.
  const artifactOrigin = `http://ui.localhost:${new URL(baseURL ?? "http://127.0.0.1:8787").port}`;
  const toolCommands: unknown[] = [];
  let loads = 0;
  const toolEvents = [
    { type: "tool/call", call: { id: "call-weather", name: TOOL_NAME } },
    {
      type: "tool/result",
      callId: "call-weather",
      content: JSON.stringify({ temperature: 24 }),
      isError: false,
    },
  ] as const;

  await page.route(
    new RegExp(`/api/bots/[^/]+/package-ui(?:/tools)?$`),
    async (route) => {
      const url = new URL(route.request().url());
      const botId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
      if (url.pathname.endsWith("/tools")) {
        const command: unknown = route.request().postDataJSON();
        toolCommands.push(command);
        expect(command).toMatchObject({
          schemaVersion: 1,
          packageId: PACKAGE_ID,
          name: TOOL_NAME,
          input: { city: "Sydney" },
        });
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            schemaVersion: 1,
            runId: "run-iframe-tool",
            text: "",
            events: toolEvents,
          }),
        });
        return;
      }
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          schemaVersion: 1,
          botId,
          artifactOrigin,
          contributions: [
            {
              packageId: PACKAGE_ID,
              displayName: "Sydney Weather",
              provenance: "Bot-authored",
              pages: [
                {
                  id: PAGE_ID,
                  artifact: {
                    contentHash: CONTENT_HASH,
                    size: new TextEncoder().encode(artifactHtml()).byteLength,
                    mediaType: "text/html",
                    bundlerVersion: "frockbot-inline-html@1",
                  },
                  mounts: [
                    { slot: "frockbot.bot-settings-sections", order: 20 },
                  ],
                },
              ],
              entries: [],
              declaredTools: [TOOL_NAME],
            },
          ],
        }),
      });
    },
  );
  await page.route(
    `${artifactOrigin}/packages/${CONTENT_HASH}.html`,
    async (route) => {
      loads += 1;
      await route.fulfill({
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy":
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'",
          "cache-control": "public, max-age=31536000, immutable",
        },
        body: artifactHtml(),
      });
    },
  );

  testInfo.annotations.push({
    type: "package-ui-origin",
    description: artifactOrigin,
  });
  return { toolCommands, documentLoads: () => loads };
}

/**
 * The framed page itself.
 *
 * The iframe carries the Package's display name as its title, which is the
 * host's own doing (`HostFrame` passes the contribution's name down as the
 * frame's label) and the one handle a spec has on a platform view: it is not
 * inside the semantics node that names the surface around it.
 */
function packageFrame(page: Page): Locator {
  // The last one: a mount the shell has moved — the panel's column at desktop
  // width, the panel's page on the phone — leaves the frame it replaced in the
  // document, and the newest is the one on screen.
  return page.locator('iframe[title="Sydney Weather"]').last();
}

/**
 * The frame's box, once the shell has stopped moving it.
 *
 * A panel that becomes a page slides, and the engine repositions the platform
 * view every frame of that: a box read mid-transition is of a layout that
 * exists for 240ms, and it is wider than the one that lands.
 */
async function settledFrameBox(
  page: Page,
): Promise<{ x: number; width: number }> {
  let previous = { x: Number.NaN, width: Number.NaN };
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const box = await packageFrame(page).boundingBox();
    if (box && box.x === previous.x && box.width === previous.width) return box;
    previous = { x: box?.x ?? Number.NaN, width: box?.width ?? Number.NaN };
    await page.waitForTimeout(250);
  }
  throw new Error("the framed page never settled");
}

/**
 * The document is a canvas, so it can only overflow if the engine's own host
 * element does. The frame's box is measured beside it, because a platform view
 * is real DOM that a too-wide layout would push past the viewport.
 */
async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(0);
  const frame = await settledFrameBox(page);
  const width = page.viewportSize()?.width ?? 0;
  expect(frame.x).toBeGreaterThanOrEqual(0);
  expect(frame.x + frame.width).toBeLessThanOrEqual(width);
}

test("a sandboxed Package page works at desktop and phone widths", async ({
  page,
  userId,
  baseURL,
}, testInfo) => {
  const { toolCommands, documentLoads } = await installPackageRoutes(
    page,
    testInfo,
    baseURL,
  );
  await page.setViewportSize(DESKTOP);
  await openApplication(page, userId);
  await createBot(page, "Framed");

  // At this width the Bot's own panel is the third column and its Settings
  // entry is what the Package page mounts into, so there is nothing to open.
  const host = sem(page, `package-page-${PACKAGE_ID}-${PAGE_ID}`);
  await expect(host).toBeVisible({ timeout: 60_000 });
  // Whose page this is, said by the shell rather than by the page. The
  // attribution is chrome the surface draws around the frame, so it reaches
  // the tree as this node's own label rather than as text of its own.
  await expect(host).toHaveAttribute("aria-label", /Sydney Weather/u);
  await expect(host).toHaveAttribute("aria-label", /Built by this Bot/u);

  const frame = packageFrame(page);
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  await expect(frame).toHaveAttribute("credentialless", "");
  // The bridge round-trips: the page asked the host for a tool it declared,
  // the host posted the command the shell owns, and the answer came back as a
  // state feed the page rendered.
  await expect(
    frame.contentFrame().getByText("bridge:24", { exact: true }),
  ).toBeVisible();
  // The host relays what the page asked for and nothing else: one command per
  // document that asked. It is one command per *document* rather than one
  // outright because this host remakes the frame when the page announces
  // bridge version 2, so the page is loaded a second time and asks again.
  expect(toolCommands).toHaveLength(documentLoads());
  // And the host gave the page the height it asked for, and no other.
  await expect
    .poll(async () => Math.round((await frame.boundingBox())?.height ?? 0))
    .toBe(REQUESTED_HEIGHT);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("iframe-ui-desktop.png") });

  // The phone: the panel is a page rather than a column, and the same framed
  // page is in it.
  await page.setViewportSize(PHONE);
  await press(sem(page, "bot-panel-toggle"));
  await page.getByText("Settings", { exact: true }).click();
  await expect(host).toBeVisible({ timeout: 60_000 });
  await expect(
    frame.contentFrame().getByText("bridge:24", { exact: true }),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);
  expect((await settledFrameBox(page)).width).toBeLessThanOrEqual(PHONE.width);
  await page.screenshot({ path: testInfo.outputPath("iframe-ui-phone.png") });
});
