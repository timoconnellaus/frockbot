// An Applet is written, checked, published and used, end to end, on the real
// routes.
//
// Nothing here is faked and nothing is seeded. `applet_create` writes the SDK
// template into the Applet's source root through the Turn's own Workspace
// surface, `applet_check` and `applet_publish` post that source to the real
// `apps/applet-build` service — the Worker and its container, running beside
// this harness in the dev service registry — and the artifacts that come back
// are hash-verified and stored by the app Worker. From there the canvas slides
// the live Applet in, a second page sees a todo the first one added, and the
// Applet's own `add_todo` reaches the Bot as an ordinary tool.
//
// The build needs Docker. When it is not running this spec fails saying so,
// rather than passing without having built anything.
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { test, expect, provisionThroughUi, sendMessage } from "./fixtures.ts";
import {
  appletBuildAvailableV1,
  E2E_DEBUG_TOKEN,
  E2E_OLLAMA_GOOD_API_KEY,
  e2eToolCallPrompt,
} from "./harness.ts";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const DESKTOP = { width: 1351, height: 831 } as const;
const PHONE = { width: 390, height: 844 } as const;

/**
 * The latest Turns' tool results, from the operator surface. The transcript
 * hides them on purpose, so this is both what an assertion about what a tool
 * *did* reads and what says why when one fails.
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

/** The preview URL `applet_check` handed the Bot, from the operator surface. */
async function previewUrlFromCheck(
  page: Page,
  userId: string,
): Promise<string> {
  const results = await recentToolResults(page, userId);
  const match = results.match(
    /http:\/\/ui\.localhost:\d+\/packages\/[0-9a-f]{64}\.html/,
  );
  if (!match) {
    throw new Error(`applet_check returned no preview URL.\n${results}`);
  }
  return match[0];
}

async function runTool(
  page: Page,
  text: string,
  name: string,
  input: unknown = {},
): Promise<void> {
  // The Applets tools are first-party registrations, so the scripted model
  // calls them by name.
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

test("a Bot writes, checks and publishes an Applet, and its tool reaches the Bot", async ({
  page,
  context,
  userId,
  ollamaBaseUrl,
}) => {
  test.setTimeout(900_000);
  expect(
    appletBuildAvailableV1(),
    "Docker is not running, so apps/applet-build could not start and no Applet can be built. Start Docker and run this spec again.",
  ).toBe(true);

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
  // The building view says where the work has got to, rather than one fixed
  // line about the Applet not being live.
  const progress = canvas.getByTestId("applet-canvas-progress");
  await expect(progress).toBeVisible();
  await expect(progress.getByText("Writing the code")).toBeVisible();
  await expect(canvas.getByRole("button", { name: "server.ts" })).toBeVisible({
    timeout: 30_000,
  });
  await shot(page, "canvas-building");

  const appletId = await appletIdNamed(page, "Weekly Todos");

  // The Bot edits its own source with no Computer anywhere: the file it reads
  // back is the file the check and the publish compile.
  await runTool(page, "Read the page.", "applet_read_file", {
    appletId,
    path: "ui.tsx",
  });
  await runTool(page, "Rename the heading.", "applet_write_file", {
    appletId,
    path: "README.md",
    text: "# Weekly Todos\n\nWritten by the Bot, in the cloud.\n",
  });

  // The check builds through the real service and hands back a page to look
  // at. The artifacts are stored, so the URL resolves before anything is
  // published.
  await runTool(page, "Check it.", "applet_check", { appletId });
  const previewUrl = await previewUrlFromCheck(page, userId);
  const preview = await context.newPage();
  await preview.goto(previewUrl);
  await expect(preview.getByText("Weekly Todos")).toBeVisible({
    timeout: 60_000,
  });
  await preview.close();

  await runTool(page, "Publish it.", "applet_publish", { appletId });

  // The publish is a generation; the canvas slides the live Applet in over the
  // code view and the header names the generation instead of "no version".
  await expect(canvas.getByTestId("applet-canvas-progress"), {
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

  // The Applet's tool is an ordinary Bot tool now, registered by its bare
  // name in this Bot's catalog (not under a Package namespace), so the
  // scripted model calls it directly. The Turn that published proposed the
  // generation carrying it, and this next Turn runs on it.
  await sendMessage(
    page,
    `Add a todo to call mum.\n${e2eToolCallPrompt("add_todo", { title: "Call mum" })}`,
  );
  await expect(secondUi.getByText("Call mum")).toBeVisible({ timeout: 60_000 });
  await expect(ui.getByText("Call mum")).toBeVisible({ timeout: 60_000 });
  // That Turn wrote no source, so the canvas stayed where the User was. A Turn
  // that only calls an Applet's tool must not throw either page back to the
  // code view — which is what the canvas did while it followed the store's
  // re-reads instead of the files.
  for (const open of [page, second]) {
    await expect(
      open
        .getByRole("region", { name: /Applet Weekly Todos/ })
        .getByRole("tab", { name: "App" }),
    ).toHaveAttribute("aria-selected", "true");
  }
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
