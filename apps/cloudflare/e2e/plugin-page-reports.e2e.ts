// A Plugin's page that tells its Bot what went wrong (ADR 0036, amended
// 2026-09-25). The panel read and the stored page are intercepted, as in
// `plugin-page-panel.e2e.ts`; the page's reports are not. Each goes from the
// production client to the real Worker, which hands it to the real Bot, and the
// spec only watches the wire. This Bot holds no Plugin, so its answer is a
// refusal — the Bot's own words, from its own Composition.
import { mkdirSync, writeFileSync } from "node:fs";
import { withPluginPageBridgeV1 } from "@frockbot/core/contracts";
import { PLUGIN_PAGE_CSP_V1 } from "../src/plugin-page-route.ts";
import type { Page } from "@playwright/test";
import {
  type AllowedFailures,
  test,
  expect,
  createBot,
  openApplication,
  openBotPage,
  press,
  sem,
} from "./fixtures.ts";

const CONTENT_HASH = "e".repeat(64);
const PLUGIN_ID = "score";
const EVIDENCE = process.env.FROCKBOT_E2E_EVIDENCE_DIR ?? "";

/** A page that fails in every way the helper hears, then logs a reading. */
function pageHtml(): string {
  return withPluginPageBridgeV1(`<!doctype html>
<html><head><title>Score</title></head><body>
<output id="status">waiting</output>
<button id="helper">Fail through the helper</button>
<button id="flood">Log thirty</button>
<button id="direct">Post thirty past the helper</button>
<pre id="heard"></pre>
<script>
const heard = [];
addEventListener("message", (e) => {
  heard.push(e.data && e.data.type);
  document.getElementById("heard").textContent = "heard: " + heard.join(",");
});
frockbot.ready.then(() => {
  document.getElementById("status").textContent = "ready";
});
document.getElementById("helper").onclick = () => {
  frockbot.log("input peaks at 0.004, threshold 0.02");
  console.error("greeting lost", { after: 5000 });
  Promise.reject(new Error("lost greeting"));
  setTimeout(() => { throw new TypeError("detector is not a function"); }, 0);
  setTimeout(() => frockbot.log("x".repeat(700)), 50);
};
document.getElementById("flood").onclick = () => {
  for (let i = 1; i <= 30; i += 1) frockbot.log("flood " + i);
};
document.getElementById("direct").onclick = () => {
  parent.postMessage({ frockbotPage: 1, type: "report", level: "error", text: "y".repeat(501) }, "*");
  parent.postMessage({ frockbotPage: 1, type: "report", level: "warn", text: "wrong level" }, "*");
  for (let i = 1; i <= 30; i += 1) {
    parent.postMessage({ frockbotPage: 1, type: "report", level: "error", text: "direct " + i }, "*");
  }
};
</script></body></html>`);
}

interface Wire {
  request: Record<string, unknown>;
  status: number;
  answer: string;
}

async function installRoutes(
  page: Page,
  baseURL: string | undefined,
): Promise<{ reports: Wire[] }> {
  const appOrigin = new URL(baseURL ?? "http://127.0.0.1:8787").origin;
  const reports: Wire[] = [];
  let focused = false;
  // Watched, not answered: the real Worker and the real Bot answer it.
  await page.route(/\/api\/bots\/[^/]+\/panels\/page-report$/, async (route) => {
    const response = await route.fetch();
    const answer = await response.text();
    reports.push({
      request: route.request().postDataJSON() as Record<string, unknown>,
      status: response.status(),
      answer,
    });
    await route.fulfill({ response, body: answer });
  });
  await page.route(
    /\/api\/bots\/[^/]+\/panels\/(open|focus)$/,
    async (route) => {
      const url = new URL(route.request().url());
      const botId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
      const runs = botId.startsWith("reporting-");
      if (url.pathname.endsWith("/panels/focus")) {
        focused = true;
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ status: "applied" }),
        });
        return;
      }
      await route.fulfill({
        contentType: "application/json",
        headers: { "cache-control": "no-store" },
        body: JSON.stringify(
          !runs
            ? { schemaVersion: 1, bag: [], focus: { pluginId: null }, doors: [] }
            : {
                schemaVersion: 1,
                bag: [
                  {
                    pluginId: PLUGIN_ID,
                    displayName: "Score",
                    surfaceId: PLUGIN_ID,
                    label: "Score",
                  },
                ],
                focus: focused
                  ? { pluginId: PLUGIN_ID, surfaceId: PLUGIN_ID }
                  : { pluginId: null },
                ...(focused
                  ? {
                      page: {
                        url: `${appOrigin}/plugin-pages/${CONTENT_HASH}.html`,
                        state: {},
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
        },
        body: pageHtml(),
      });
    },
  );
  return { reports };
}

/** The page fails on purpose, and this Bot refuses a Plugin it does not hold. */
function allowReports(allowed: AllowedFailures) {
  allowed.console.push(
    /greeting lost/,
    /detector is not a function/,
    /lost greeting/,
    /Failed to load resource.*400/,
  );
}

async function openScorePage(page: Page, userId: string) {
  await page.setViewportSize({ width: 1351, height: 831 });
  await openApplication(page, userId);
  await createBot(page, "Reporting");
  await openBotPage(page);
  await press(sem(page, `bot-page-panel-${PLUGIN_ID}`));
  await expect(sem(page, "conversation-panel-page")).toBeVisible({
    timeout: 60_000,
  });
  const content = page.locator('iframe[title="Score"]').last().contentFrame();
  await expect(content.getByText("ready", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  return content;
}

function save(name: string, value: unknown) {
  if (!EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  writeFileSync(`${EVIDENCE}/${name}`, JSON.stringify(value, null, 2));
}

test("a page's errors, console.error and log reach its Bot through the helper, twenty a minute", async ({
  page,
  userId,
  baseURL,
  allowedFailures,
}) => {
  allowReports(allowedFailures);
  const { reports } = await installRoutes(page, baseURL);
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  const content = await openScorePage(page, userId);
  const heardBefore = await content.locator("#heard").textContent();

  await content.locator("#helper").click();
  await expect.poll(() => reports.length, { timeout: 30_000 }).toBe(5);
  const texts = reports.map((wire) => wire.request.text as string);
  expect(reports.map((wire) => wire.request.level)).toEqual(
    expect.arrayContaining(["log", "error"]),
  );
  expect(texts).toContain("input peaks at 0.004, threshold 0.02");
  expect(texts).toContain('greeting lost {"after":5000}');
  expect(texts.some((text) => text.startsWith("Unhandled rejection: Error: lost greeting"))).toBe(true);
  expect(texts.some((text) => text.startsWith("TypeError: detector is not a function"))).toBe(true);
  expect(texts).toContain("x".repeat(500));
  for (const wire of reports) {
    expect(wire.request).toMatchObject({
      schemaVersion: 1,
      pluginId: PLUGIN_ID,
      surfaceId: PLUGIN_ID,
    });
    expect(Object.keys(wire.request).sort()).toEqual([
      "device",
      "level",
      "pluginId",
      "schemaVersion",
      "surfaceId",
      "text",
    ]);
    // The real Bot answered, from its own Composition: it holds no "score".
    expect(wire.status).toBe(400);
    expect(JSON.parse(wire.answer)).toEqual({ error: '"score" has no page "score".' });
  }
  // The original console.error still ran.
  expect(consoleErrors.some((text) => text.includes("greeting lost"))).toBe(true);

  // Thirty more in the same minute: the helper sends fifteen and drops the rest.
  await content.locator("#flood").click();
  await expect.poll(() => reports.length, { timeout: 30_000 }).toBe(20);
  await page.waitForTimeout(3_000);
  expect(reports).toHaveLength(20);
  // Sent concurrently, so the Worker may hear them in any order.
  expect(
    reports
      .map((wire) => wire.request.text as string)
      .filter((text) => text.startsWith("flood "))
      .sort(),
  ).toEqual(Array.from({ length: 15 }, (_, index) => `flood ${index + 1}`).sort());

  // Nothing came back to the page for any of it.
  expect(await content.locator("#heard").textContent()).toBe(heardBefore);
  await page.screenshot({
    path: EVIDENCE ? `${EVIDENCE}/helper-reports.png` : undefined,
  });
  save("helper-reports-wire.json", { heardBefore, reports, consoleErrors });
});

test("a page posting past the helper is still held to twenty a minute and 500 characters by the host", async ({
  page,
  userId,
  baseURL,
  allowedFailures,
}) => {
  allowReports(allowedFailures);
  const { reports } = await installRoutes(page, baseURL);
  const content = await openScorePage(page, userId);
  const heardBefore = await content.locator("#heard").textContent();

  await content.locator("#direct").click();
  await expect.poll(() => reports.length, { timeout: 30_000 }).toBe(20);
  await page.waitForTimeout(3_000);
  expect(reports).toHaveLength(20);
  // The oversized and wrongly-levelled ones never left the host.
  // Sent concurrently, so the Worker may hear them in any order.
  expect(reports.map((wire) => wire.request.text).sort()).toEqual(
    Array.from({ length: 20 }, (_, index) => `direct ${index + 1}`).sort(),
  );
  expect(await content.locator("#heard").textContent()).toBe(heardBefore);
  await page.screenshot({
    path: EVIDENCE ? `${EVIDENCE}/direct-reports.png` : undefined,
  });
  save("direct-reports-wire.json", { heardBefore, reports });
});
