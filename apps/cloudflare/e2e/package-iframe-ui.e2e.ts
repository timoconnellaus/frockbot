// Non-first-party Package UI stays a page, even when the hosted shell is the
// desktop-sized site or the same site at its 390px phone breakpoint. The
// Package projection and immutable object are intercepted because this suite's
// bundler is intentionally absent; everything that hosts and talks to the page
// is the production client bundle.
import { PACKAGE_IFRAME_HELPER_JS_V1 } from "@frockbot/kernel-contracts";
import type { Page, TestInfo } from "@playwright/test";
import { test, expect, provisionThroughUi, sendMessage } from "./fixtures.ts";
import { E2E_OLLAMA_GOOD_API_KEY } from "./harness.ts";

const CONTENT_HASH = "a".repeat(64);
const PACKAGE_ID = "weather-card";
const TOOL_NAME = "weather_lookup";
const PHONE = { width: 390, height: 844 } as const;

function artifactHtml(): string {
  return `<!doctype html>
<html><body><output id="settings">waiting</output><output id="view">waiting</output>
<script>${PACKAGE_IFRAME_HELPER_JS_V1}</script>
<script>
window.frockbot.ready.then(({ slot }) => {
  const view = document.getElementById('view');
  if (slot === 'frockbot.bot-settings-sections') {
    const settings = document.getElementById('settings');
    window.frockbot.subscribe('settings', value => {
      settings.textContent = 'settings:' + JSON.stringify(value);
    });
    window.frockbot.subscribe('tool:${TOOL_NAME}', value => {
      view.textContent = 'bridge:' + JSON.parse(value.content).temperature;
    });
    window.frockbot.callTool('${TOOL_NAME}', { city: 'Sydney' });
  } else {
    window.frockbot.subscribe('tool:${TOOL_NAME}', value => {
      view.textContent = 'result:' + JSON.stringify(value);
    });
  }
  window.frockbot.resize(180);
});
</script></body></html>`;
}

async function installPackageRoutes(
  page: Page,
  testInfo: TestInfo,
): Promise<{ toolCommands: unknown[] }> {
  const port = process.env.FROCKBOT_E2E_PORT;
  if (!port) throw new Error("the E2E app port is unavailable");
  const artifactOrigin = `http://ui.localhost:${port}`;
  const toolCommands: unknown[] = [];
  let chatInput: string | undefined;
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
          generationId: "generation-ui",
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
          generationId: "generation-ui",
          artifactOrigin,
          contributions: [
            {
              packageId: PACKAGE_ID,
              displayName: "Sydney Weather",
              provenance: "Bot-authored",
              pages: [
                {
                  id: "main",
                  artifact: {
                    contentHash: CONTENT_HASH,
                    size: new TextEncoder().encode(artifactHtml()).byteLength,
                    mediaType: "text/html",
                    bundlerVersion: "frockbot-inline-html@1",
                  },
                  mounts: [
                    { slot: "frockbot.bot-settings-sections", order: 20 },
                    { slot: `frockbot.tool-result:${TOOL_NAME}`, order: 20 },
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
  await page.route(new RegExp(`/api/bots/[^/]+/turns$`), async (route) => {
    if (route.request().method() === "POST") {
      const command = route.request().postDataJSON() as { text?: unknown };
      chatInput = typeof command.text === "string" ? command.text : "";
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          schemaVersion: 1,
          runId: "run-chat-tool",
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
        runs:
          chatInput === undefined
            ? []
            : [
                {
                  schemaVersion: 2,
                  runId: "run-chat-tool",
                  admittedAt: "2026-09-02T00:00:00.000Z",
                  input: chatInput,
                  status: "completed",
                  events: toolEvents,
                  outcome: { type: "completed", text: "" },
                },
              ],
        page: { truncated: false },
      }),
    });
  });

  testInfo.annotations.push({
    type: "package-ui-origin",
    description: artifactOrigin,
  });
  return { toolCommands };
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

test("a sandboxed Package page works at desktop and phone widths", async ({
  page,
  userId,
  ollamaBaseUrl,
}, testInfo) => {
  const { toolCommands } = await installPackageRoutes(page, testInfo);
  await provisionThroughUi(page, {
    userId,
    apiKey: E2E_OLLAMA_GOOD_API_KEY,
    apiBaseUrl: ollamaBaseUrl,
    botName: "Framed",
  });

  await page.getByRole("button", { name: "Bot settings" }).click();
  const panel = page.getByRole("region", { name: "Settings" });
  await panel.getByText("Advanced", { exact: true }).click();
  const settingsFrame = panel.locator(".package-iframe-frame");
  await expect(settingsFrame.getByText("Sydney Weather")).toBeVisible();
  await expect(settingsFrame.getByText("Built by this Bot")).toBeVisible();
  const iframe = settingsFrame.locator("iframe");
  await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
  await expect(iframe).toHaveAttribute("credentialless", "");
  await expect(iframe).toHaveCSS("height", "180px");
  await expect(
    iframe.contentFrame().getByText("bridge:24", { exact: true }),
  ).toBeVisible();
  expect(toolCommands).toHaveLength(1);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("iframe-ui-desktop.png") });

  await page.setViewportSize(PHONE);
  await expect(settingsFrame).toBeVisible();
  await expectNoHorizontalOverflow(page);
  const frameBox = await settingsFrame.boundingBox();
  expect(frameBox?.width ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
    PHONE.width,
  );
  await page.screenshot({ path: testInfo.outputPath("iframe-ui-phone.png") });

  await page.getByRole("button", { name: "Hide side panel" }).click();
  await sendMessage(page, "Show Sydney weather");
  const resultFrame = page.locator(".message-package-iframe");
  await expect(resultFrame).toBeVisible();
  await expect(
    resultFrame
      .locator("iframe")
      .contentFrame()
      .getByText('result:{"temperature":24}', { exact: true }),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath("iframe-ui-tool-result-phone.png"),
  });
});
