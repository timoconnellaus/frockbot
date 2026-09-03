// An Applet is published and used, end to end, on the real routes.
//
// `applets.e2e.ts` stops where the Computer starts: a publish reads `dist/`
// from the Applets Package's durable root, and only `applet build` on the
// Computer writes it. This spec supplies exactly that one missing writer. The
// template is built with the published `applet` CLI under plain Node — what
// the Computer runs — and its three files are put into the run's local
// Workspace bucket at the keys the Computer's sync would land them on. From
// there nothing is faked: the Bot's `applet_publish` reconciles nothing (no
// Computer is assigned), reads the store, verifies the build manifest against
// the bytes, stores the artifacts, records the generation, mounts the facet,
// and proposes the Bot's next Composition; the canvas slides the live Applet
// in; a second page sees a todo the first one added; and the Applet's own
// `add_todo` reaches the Bot as an ordinary tool.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { test, expect, provisionThroughUi, sendMessage } from "./fixtures.ts";
import {
  E2E_DEBUG_TOKEN,
  E2E_OLLAMA_GOOD_API_KEY,
  e2eToolCallPrompt,
  seedWorkspaceObject,
} from "./harness.ts";

/**
 * The latest Turns' tool results, from the operator surface. The transcript
 * hides them on purpose, so when an assertion about what a tool *did* fails,
 * this is what says why.
 */
async function recentToolResults(page: Page, userId: string): Promise<string> {
  const headers = { authorization: `Bearer ${E2E_DEBUG_TOKEN}` };
  const bots = (await (
    await page.request.get(`/api/debug/bots?userId=${userId}`, { headers })
  ).json()) as { bots?: Array<{ botId: string }> };
  const botId = bots.bots?.[0]?.botId;
  if (!botId) return "no Bot";
  const detail = await page.request.get(
    `/api/debug/bots/${botId}?userId=${userId}&events=true`,
    { headers },
  );
  const applets = await page.request.get("/api/applets");
  return `${JSON.stringify(await applets.json(), null, 2)}\n${JSON.stringify(await detail.json(), null, 2)}`;
}

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const sdkRoot = resolve(repoRoot, "packages/applet-sdk");
const cli = resolve(sdkRoot, "dist/cli.mjs");
const DESKTOP = { width: 1351, height: 831 } as const;
const PHONE = { width: 390, height: 844 } as const;

async function run(
  command: string,
  args: string[],
  cwd: string,
): Promise<void> {
  await new Promise<void>((done, fail) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.on("error", fail);
    child.on("exit", (code) =>
      code === 0
        ? done()
        : fail(new Error(`${command} ${args.join(" ")} exited with ${code}`)),
    );
  });
}

/** The template, scaffolded and built the way the Computer does it. */
async function buildTemplate(displayName: string): Promise<string> {
  await run("bun", ["scripts/build-cli.ts"], sdkRoot);
  const parent = await mkdtemp(join(tmpdir(), "frockbot-applet-e2e-"));
  await run("node", [cli, "new", displayName], parent);
  const directory = join(parent, "weekly-todos");
  await run("node", [cli, "build"], directory);
  return join(directory, "dist");
}

async function seedBuild(
  port: number,
  userId: string,
  appletId: string,
  dist: string,
): Promise<void> {
  const root = `workspace/package-declared:${encodeURIComponent(userId)}:applets:source/${appletId}/dist`;
  await seedWorkspaceObject(
    port,
    `${root}/server.js`,
    join(dist, "server.js"),
    "application/javascript",
  );
  await seedWorkspaceObject(
    port,
    `${root}/ui.html`,
    join(dist, "ui.html"),
    "text/html; charset=utf-8",
  );
  await seedWorkspaceObject(
    port,
    `${root}/manifest.json`,
    join(dist, "manifest.json"),
    "application/json",
  );
}

async function runTool(
  page: Page,
  text: string,
  name: string,
  input: unknown = {},
): Promise<void> {
  await sendMessage(page, `${text}\n${e2eToolCallPrompt(name, input)}`);
}

async function appletIdNamed(page: Page, displayName: string): Promise<string> {
  const response = await page.request.get("/api/applets");
  const body = (await response.json()) as {
    applets: Array<{ appletId: string; displayName: string }>;
  };
  const applet = body.applets.find(
    (candidate) => candidate.displayName === displayName,
  );
  if (!applet) throw new Error(`the Applet directory has no ${displayName}`);
  return applet.appletId;
}

/** The live Applet: the canvas page's frame, then the Applet's own inside it. */
function appletUi(page: Page) {
  return page
    .getByRole("region", { name: /Applet Weekly Todos/ })
    .locator(".applet-canvas-app iframe")
    .contentFrame()
    .locator("iframe")
    .contentFrame();
}

/** The checked-in record of what this Applet looks like, per the plan's §5a. */
const shotDirectory = resolve(repoRoot, "docs/screenshots/applets");

/**
 * Wait for transitions before a screenshot: the canvas slides, the panel
 * animates its width, and a picture taken mid-way is of a layout that exists
 * for 240ms. Only transitions — an animation may be infinite.
 */
async function settle(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .filter((animation) => "transitionProperty" in animation)
      .every((animation) => animation.playState !== "running"),
  );
}

async function shot(page: Page, name: string): Promise<void> {
  await settle(page);
  await mkdir(shotDirectory, { recursive: true });
  await page.screenshot({ path: join(shotDirectory, `${name}.png`) });
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

test("a Bot publishes an Applet, it goes live in the canvas, and its tool reaches the Bot", async ({
  page,
  context,
  userId,
  ollamaBaseUrl,
}) => {
  test.setTimeout(600_000);
  const port = Number(process.env.FROCKBOT_E2E_PORT);
  const dist = await buildTemplate("Weekly Todos");

  await page.setViewportSize(DESKTOP);
  await provisionThroughUi(page, {
    userId,
    apiKey: E2E_OLLAMA_GOOD_API_KEY,
    apiBaseUrl: ollamaBaseUrl,
    botName: "Builder",
  });

  await runTool(page, "Build me a todo list.", "applet_create", {
    displayName: "Weekly Todos",
  });
  const canvas = page.getByRole("region", { name: /Applet Weekly Todos/ });
  // The Turn settled, so the client re-read the focus the tool set: the canvas
  // opens on the new Applet without a reload, in its building state.
  await expect(canvas).toBeVisible({ timeout: 60_000 });
  await expect(canvas.getByText("No published version yet")).toBeVisible();
  await expect(canvas.getByRole("button", { name: "server.ts" })).toBeVisible({
    timeout: 30_000,
  });
  await shot(page, "canvas-building");

  // What `applet build` on the Computer would have written, landed where the
  // sync lands it.
  const appletId = await appletIdNamed(page, "Weekly Todos");
  await seedBuild(port, userId, appletId, dist);

  await runTool(page, "Publish it.", "applet_publish", { appletId });

  // The publish is a generation; the canvas slides the live Applet in over the
  // code view and the header names the generation instead of "no version".
  await expect(canvas.getByText("No published version yet"), {
    message: await recentToolResults(page, userId),
  }).toHaveCount(0, { timeout: 60_000 });
  await expect(canvas.getByRole("tab", { name: "App" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const ui = appletUi(page);
  await expect(ui.getByText("Weekly Todos")).toBeVisible({ timeout: 60_000 });
  await expect(ui.getByText("Nothing yet")).toBeVisible({ timeout: 30_000 });
  await expectNoHorizontalOverflow(page);
  await shot(page, "canvas-ready-empty");

  // Real-time by default: an optimistic insert on this page is the row a
  // second page of the same User reads over its own socket.
  await ui.getByRole("textbox", { name: "New todo" }).fill("Buy milk");
  await ui.getByRole("button", { name: "Add" }).click();
  await expect(ui.getByText("Buy milk")).toBeVisible();

  const second = await context.newPage();
  await second.setViewportSize(DESKTOP);
  await second.goto(`/?as_user=${userId}`);
  const secondUi = appletUi(second);
  await expect(secondUi.getByText("Buy milk")).toBeVisible({ timeout: 60_000 });

  // The Applet's tool is an ordinary Bot tool now. The Turn that published
  // proposed the generation carrying it, and this next Turn runs on it.
  await runTool(page, "Add a todo to call mum.", "add_todo", {
    title: "Call mum",
  });
  await expect(secondUi.getByText("Call mum")).toBeVisible({ timeout: 60_000 });
  await expect(ui.getByText("Call mum")).toBeVisible({ timeout: 60_000 });
  await shot(page, "canvas-live");

  // The code view is still there behind the Applet, one toggle away.
  await canvas.getByRole("tab", { name: "Code" }).click();
  await expect(canvas.getByRole("button", { name: "server.ts" })).toBeVisible();
  await shot(page, "canvas-code");
  await second.close();

  // The phone: the same published Applet, as a full-height sheet.
  await page.setViewportSize(PHONE);
  await page.reload();
  const chip = page.getByRole("button", { name: /Applet: Weekly Todos/ });
  await expect(chip).toBeVisible({ timeout: 60_000 });
  await shot(page, "phone-chip");
  await chip.click();
  await expect(appletUi(page).getByText("Buy milk")).toBeVisible({
    timeout: 60_000,
  });
  await expectNoHorizontalOverflow(page);
  await shot(page, "phone-ready");
});
