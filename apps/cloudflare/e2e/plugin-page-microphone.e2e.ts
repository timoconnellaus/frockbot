// A Plugin's page that listens (ADR 0036): the guitar tuner the plugins Skill
// teaches, taken from `references/microphone.md` as written. The panel read
// and the stored page are intercepted — this suite has no build service to
// publish one — and the page is answered with the Worker's own policy. The
// microphone is Chromium's fake device, which the suite's config grants: the
// host opens it, never the page, and the host draws who is listening and the
// Stop that ends it.
import { readFileSync } from "node:fs";
import { withPluginPageBridgeV1 } from "@frockbot/core/contracts";
import { PLUGIN_PAGE_CSP_V1 } from "../src/plugin-page-route.ts";
import type { Page } from "@playwright/test";
import {
  test,
  expect,
  createBot,
  openApplication,
  openBotPage,
  press,
  sem,
} from "./fixtures.ts";

const CONTENT_HASH = "d".repeat(64);
const PLUGIN_ID = "tuner";

function tunerPage(): string {
  const reference = readFileSync(
    new URL(
      "../../../app/plugins/skills/plugins/references/microphone.md",
      import.meta.url,
    ),
    "utf8",
  );
  const html = /```html\n([\s\S]*?)```/.exec(reference)?.[1];
  if (!html) throw new Error("microphone.md has no tuner page");
  return withPluginPageBridgeV1(html);
}

async function installTunerRoutes(
  page: Page,
  baseURL: string | undefined,
): Promise<void> {
  const appOrigin = new URL(baseURL ?? "http://127.0.0.1:8787").origin;
  let focused = false;
  await page.route(
    /\/api\/bots\/[^/]+\/panels\/(open|focus)$/,
    async (route) => {
      const url = new URL(route.request().url());
      const botId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
      if (url.pathname.endsWith("/focus")) {
        focused = true;
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ status: "applied" }),
        });
        return;
      }
      const runs = botId.startsWith("tuned-");
      const tab = {
        pluginId: PLUGIN_ID,
        displayName: "Tuner",
        surfaceId: PLUGIN_ID,
        label: "Tuner",
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
                        state: { a4: 440 },
                        abilities: ["microphone"],
                      },
                    }
                  : {}),
                doors: [
                  {
                    pluginId: PLUGIN_ID,
                    label: "Tuner",
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
        },
        body: tunerPage(),
      });
    },
  );
}

test("a Plugin's tuner hears the microphone through the host, and the host stops it", async ({
  page,
  userId,
  baseURL,
}, testInfo) => {
  await installTunerRoutes(page, baseURL);
  await page.setViewportSize({ width: 1351, height: 831 });
  await openApplication(page, userId);
  await createBot(page, "Tuned");
  await openBotPage(page);
  await press(sem(page, `bot-page-panel-${PLUGIN_ID}`));

  const frame = page.locator('iframe[title="Tuner"]').last();
  // The page never holds the microphone itself: its frame is granted nothing.
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  await expect(frame).not.toHaveAttribute("allow", /.+/);
  const tuner = frame.contentFrame();
  await expect(tuner.locator("#listen")).toBeVisible({ timeout: 60_000 });

  await tuner.locator("#listen").click();
  // The host opened it, and says so in its own chrome, outside the page.
  const inUse = sem(page, "plugin-page-microphone");
  await expect(inUse).toBeVisible({ timeout: 30_000 });
  await expect(tuner.getByText("Listening.", { exact: true })).toBeVisible();
  // Chromium's fake device is heard, frame after frame, through the bridge.
  await expect
    .poll(
      async () =>
        Number(await tuner.locator("#status").getAttribute("data-frames")),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(10);
  await page.screenshot({ path: testInfo.outputPath("tuner-listening.png") });

  // The host's Stop ends it, and the page is told why.
  await press(sem(page, "plugin-page-microphone-stop"));
  await expect(inUse).toBeHidden();
  await expect(
    tuner.getByText("You stopped the microphone.", { exact: true }),
  ).toBeVisible();
  const heard = Number(
    await tuner.locator("#status").getAttribute("data-frames"),
  );
  await page.waitForTimeout(500);
  expect(
    Number(await tuner.locator("#status").getAttribute("data-frames")),
  ).toBe(heard);
});
