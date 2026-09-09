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
//
// Under Flutter the canvas is `applets/canvas.dart` and its chrome is named by
// `AppletIds`; the live Applet is a platform view over the Applet's own
// document, so reaching into it is one `contentFrame` hop from the iframe the
// host titled "Applet".
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FrameLocator, Locator, Page } from "@playwright/test";
import {
  test,
  expect,
  press,
  provisionThroughUi,
  sem,
  sendMessage,
} from "./fixtures.ts";
import {
  appletBuildAvailableV1,
  E2E_DEBUG_TOKEN,
  E2E_OLLAMA_GOOD_API_KEY,
  e2eFrockbotToolCallPrompt,
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

/**
 * The preview URL `applet_check` handed the Bot, from the operator surface.
 *
 * Polled, because a real check is a type check, a lint and two bundles inside
 * a container: the composer is free again long before the tool has answered,
 * and reading the operator surface once caught the Turn mid-build and called
 * that "no preview URL". A check that answers with diagnostics instead ends
 * the wait at once, with what it said.
 */
async function previewUrlFromCheck(
  page: Page,
  userId: string,
): Promise<string> {
  const deadline = Date.now() + 300_000;
  let results = "";
  while (Date.now() < deadline) {
    results = await recentToolResults(page, userId);
    const match = results.match(
      /http:\/\/ui\.localhost:\d+\/packages\/[0-9a-f]{64}\.html/,
    );
    if (match) return match[0];
    if (results.includes("does not build yet")) break;
    await new Promise((sleep) => setTimeout(sleep, 2_000));
  }
  throw new Error(`applet_check returned no preview URL.\n${results}`);
}

async function runTool(
  page: Page,
  text: string,
  name: string,
  input: unknown = {},
): Promise<void> {
  // The Applets tools are first-party registrations, so the scripted model
  // calls them by name.
  await sendMessage(page, `${text}\n${e2eFrockbotToolCallPrompt(name, input)}`);
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

/**
 * Wait for words the shell drew inside `scope`.
 *
 * Where those words end up depends on how the widget was named: a leaf's own
 * text is the element's content, a merged subtree's is its ancestor's
 * `aria-label`, and a semantics container holds its label while its identifier
 * sits on the node above. A spec means the sentence, not the placement.
 */
async function expectSaid(scope: Locator, copy: string): Promise<void> {
  await expect
    .poll(
      async () =>
        await scope.evaluate(
          (node, text) =>
            node.textContent?.includes(text) === true ||
            node.getAttribute("aria-label")?.includes(text) === true ||
            [...node.querySelectorAll("[aria-label]")].some((child) =>
              child.getAttribute("aria-label")?.includes(text),
            ),
          copy,
        ),
      { timeout: 60_000, message: `the shell never said "${copy}"` },
    )
    .toBe(true);
}

/** The canvas, wherever this width puts it: a column, or a page of its own. */
function canvasOf(page: Page): Locator {
  return sem(page, "applet-canvas");
}

/**
 * The live Applet, inside the frame the canvas draws it in.
 *
 * One hop, not two: the canvas frames the Applet's own document directly and
 * titles that frame "Applet". (The Applets Package's page nests a second frame,
 * but that is another surface and not this one.)
 */
function appletUi(page: Page): FrameLocator {
  return appletViewer(page).contentFrame();
}

/**
 * Open the Applet canvas from the header control that owns it. At every width
 * this is the same gesture; only what it opens differs — a column beside the
 * conversation, or a page over it.
 */
async function openCanvas(page: Page): Promise<void> {
  const canvas = canvasOf(page);
  if (await canvas.isVisible().catch(() => false)) return;
  await press(sem(page, "applet-chip"));
  await press(
    page.locator('[flt-semantics-identifier^="applet-choice-"]').first(),
  );
  await expect(canvas).toBeVisible({ timeout: 60_000 });
}

/**
 * The frame the canvas draws the live Applet in.
 *
 * The last one: a canvas the shell has moved — a column at desktop width, a
 * page on the phone — leaves the frame it replaced in the document, and the
 * newest is the one on screen.
 */
function appletViewer(page: Page): Locator {
  return page.locator('iframe[title="Applet"]').last();
}

/**
 * The canvas is showing the Applet rather than its source.
 *
 * The toggle's own halves say nothing about which is chosen — Flutter draws a
 * segmented button as two plain buttons in the accessibility tree — and the
 * code view stays built underneath, so what tells a person which view they are
 * on is the Applet's own document over it. That is what this reads.
 */
async function expectShowingApp(page: Page): Promise<void> {
  await expect(appletViewer(page)).toBeVisible({ timeout: 60_000 });
  await expect(appletUi(page).getByText("Weekly Todos")).toBeVisible({
    timeout: 60_000,
  });
}

function tab(page: Page, name: "App" | "Code"): Locator {
  return sem(page, "applet-canvas-tabs").getByRole("button", { name });
}

/** The checked-in record of what this Applet looks like, per the plan's §5a. */
const shotDirectory = resolve(repoRoot, "docs/screenshots/applets");

/**
 * Wait for the shell to stop moving before a screenshot: the panel animates its
 * width and the canvas fades its view in, and a picture taken mid-way is of a
 * layout that exists for 240ms. The canvas is drawn to a canvas element, so
 * there is no animation to wait on in the document — what settles instead is
 * the box the engine gives the semantics node.
 */
async function settle(page: Page): Promise<void> {
  const canvas = canvasOf(page);
  let previous = -1;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    // With its own bound. `boundingBox()` waits for the element first, and
    // this project sets no action timeout — so a shot of a shell with the
    // canvas closed waited for a canvas that was never coming, and spent the
    // whole test's budget inside a `catch` that never ran.
    const box = await canvas.boundingBox({ timeout: 1_000 }).catch(() => null);
    // No canvas on screen is nothing to wait for.
    if (!box) return;
    const width = Math.round(box.width);
    if (width === previous) return;
    previous = width;
    await page.waitForTimeout(250);
  }
}

async function shot(page: Page, name: string): Promise<void> {
  await settle(page);
  await mkdir(shotDirectory, { recursive: true });
  // Bounded, and with the engine's own animation left alone. A Flutter view
  // repaints forever, so a screenshot that waits for the page to go still
  // waits for something that never happens — and an unbounded one takes the
  // whole test's budget with it rather than failing on its own line.
  await page.screenshot({
    path: join(shotDirectory, `${name}.png`),
    animations: "disabled",
    timeout: 30_000,
  });
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

// The canvas asks for the live Applet the moment it opens, and until the first
// generation is published there is none: that read answers 404 and the browser
// logs it. It is the one failure this spec expects; everything else still fails
// the test.
test.use({
  allowedFailures: {
    console: [
      /Failed to load resource: the server responded with a status of 404/u,
    ],
    requests: [],
  },
});

test("a Bot writes, checks and publishes an Applet, and its tool reaches the Bot", async ({
  page,
  context,
  userId,
  ollamaBaseUrl,
}) => {
  // Two container builds, a live Applet in an iframe, a second page watching
  // the same tables, and eight scripted Turns.
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
  await openCanvas(page);
  const canvas = canvasOf(page);
  // The Turn settled, so the client re-read the focus the tool set: the canvas
  // opens on the new Applet rather than on nothing.
  // The canvas names the Applet it is showing. The name is on the region
  // inside the identified node rather than on it: an identifier is merged onto
  // the node it annotates, and a semantics *container* is a node of its own.
  await expect(canvas.locator("[aria-label]").first()).toHaveAttribute(
    "aria-label",
    /Weekly Todos/u,
    { timeout: 60_000 },
  );
  // The building view says where the work has got to, rather than one fixed
  // line about the Applet not being live.
  const progress = sem(page, "applet-canvas-progress");
  await expect(progress).toBeVisible();
  await expectSaid(progress, "Writing the code");
  await expect(sem(page, "applet-file-server.ts")).toBeVisible({
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

  // The publish is a generation; the canvas puts the live Applet over the code
  // view and the header names the generation instead of "no version".
  await expect(sem(page, "applet-canvas-progress"), {
    message: await recentToolResults(page, userId),
  }).toHaveCount(0, { timeout: 60_000 });
  await expectShowingApp(page);
  const ui = appletUi(page);
  await expect(ui.getByText("Nothing yet")).toBeVisible({ timeout: 30_000 });
  await expectNoHorizontalOverflow(page);
  await shot(page, "canvas-ready-empty");

  // Real-time by default: an optimistic insert on this page is the row a
  // second page of the same User reads over its own socket.
  await ui.getByRole("textbox", { name: "New todo" }).fill("Buy milk");
  // The Applet's own button, pressed through its document rather than with the
  // mouse: the engine's semantics host lies over the whole view, so a click at
  // the page's coordinates is intercepted by whatever element of the shell's
  // accessibility tree happens to be there.
  await ui
    .getByRole("button", { name: "Add" })
    .evaluate((node: HTMLElement) => node.click());
  await expect(ui.getByText("Buy milk")).toBeVisible();

  const second = await context.newPage();
  await second.setViewportSize(DESKTOP);
  await second.goto(`/?as_user=${userId}`);
  await expect(sem(second, "shell-sidebar")).toBeVisible({ timeout: 120_000 });
  await openCanvas(second);
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
    await expectShowingApp(open);
  }
  await shot(page, "canvas-live");

  // The code view is still there behind the Applet, one toggle away.
  await press(tab(page, "Code"));
  await expect(appletViewer(page)).toBeHidden();
  await expect(sem(page, "applet-file-server.ts")).toBeVisible();
  await shot(page, "canvas-code");
  await second.close();

  // The phone: the same published Applet, as a full-height sheet.
  await page.setViewportSize(PHONE);
  await page.reload();
  const chip = sem(page, "applet-chip");
  await expect(chip).toBeVisible({ timeout: 60_000 });
  await shot(page, "phone-chip");
  await press(chip);
  await press(
    page.locator('[flt-semantics-identifier^="applet-choice-"]').first(),
  );
  await expect(canvasOf(page)).toBeVisible({ timeout: 60_000 });
  await expect(appletUi(page).getByText("Buy milk")).toBeVisible({
    timeout: 60_000,
  });
  await expectNoHorizontalOverflow(page);
  await shot(page, "phone-ready");
});
