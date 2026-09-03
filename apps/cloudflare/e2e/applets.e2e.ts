// The Applets Package, end to end, against the real routes.
//
// `applets-shell.e2e.ts` proves the shell — the entry, the surface, the canvas
// and its two states — with the Applet authority stubbed, because it was
// written while that lane was still in flight. This spec is the other half:
// nothing is stubbed. A Bot Turn calls `applet_create`, and everything after
// that is production — the artifact-backed Applets member mounted through the
// isolate host, the User's Applet directory, the durable source root the
// scaffold is written into, the focus the create sets, the surface page served
// from the anonymous artifact origin, and the canvas reading the source back.
//
// What is not here, and why: publishing. A publish reads `dist/` from the
// Applets Package's durable root, which `applet build` writes on the Computer,
// and an end-to-end run has no Computer and no seam that writes into the
// Workspace store from outside a Turn. The published half of the canvas is
// covered by `applets-shell.e2e.ts` on the shell side and by
// `test/applets.workerd.ts` on the authority side.
import type { Page, TestInfo } from "@playwright/test";
import { test, expect, provisionThroughUi, sendMessage } from "./fixtures.ts";
import { E2E_OLLAMA_GOOD_API_KEY, e2eToolCallPrompt } from "./harness.ts";

const PHONE = { width: 390, height: 844 } as const;

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(0);
}

/**
 * One scripted Turn, then a reload.
 *
 * The reload is the point, not a workaround: the focus a Turn sets, the
 * directory entry it made, and the source it wrote are durable, so the client
 * reads them back from the routes on the next load rather than from anything
 * the Turn left in the page.
 */
async function runTool(
  page: Page,
  text: string,
  name: string,
  input: unknown = {},
): Promise<void> {
  // The Applets member is isolate-loaded, so its tools are disclosed under
  // the `applets` namespace (ADR 0023) and a model reaches them only
  // through `call_dynamic_tool`; the scripted model does exactly that.
  await sendMessage(
    page,
    `${text}\n${e2eToolCallPrompt("call_dynamic_tool", {
      namespace: "applets",
      toolName: name,
      arguments: input,
      mcpDetails: { description: `${name} for the User` },
    })}`,
  );
  await page.reload();
}

test("a Bot creates an Applet, the canvas shows its source, and the surface lists it", async ({
  page,
  userId,
  ollamaBaseUrl,
}, testInfo: TestInfo) => {
  await provisionThroughUi(page, {
    userId,
    apiKey: E2E_OLLAMA_GOOD_API_KEY,
    apiBaseUrl: ollamaBaseUrl,
    botName: "Builder",
  });

  // The Applets entry is a manifest declaration carried by an artifact-backed
  // first-party member: no client code of this Package runs in the app origin.
  const entry = page.getByRole("button", { name: "Applets", exact: true });
  await expect(entry).toBeVisible();

  await runTool(page, "Build me a todo list.", "applet_create", {
    displayName: "Weekly Todos",
  });

  // `applet_create` focuses what it made, so the canvas opens on it, in its
  // building state, showing the scaffold the tool wrote into the durable root.
  const canvas = page.getByRole("region", { name: /Applet Weekly Todos/ });
  await expect(canvas).toBeVisible({ timeout: 60_000 });
  await expect(canvas.getByText("No published version yet")).toBeVisible();
  await expect(canvas.getByRole("button", { name: "server.ts" })).toBeVisible();
  await expect(canvas.getByRole("button", { name: "ui.tsx" })).toBeVisible();
  await canvas.getByRole("button", { name: "server.ts" }).click();
  await expect(canvas.getByText("extends Applet")).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("applets-created.png") });

  // The entry opens the Package's own list page, served from the anonymous
  // artifact origin and fed the Applets state over bridge v2.
  await entry.click();
  const surface = page.getByRole("region", { name: "Applets" });
  // A first-party page carries no provenance line: there is nobody to credit.
  await expect(surface.getByText("FrockBot Package")).toHaveCount(0);
  const listFrame = surface.locator("iframe").contentFrame();
  await expect(listFrame.getByText("Weekly Todos")).toBeVisible({
    timeout: 30_000,
  });
  await expect(listFrame.getByText(/not published yet/)).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("applets-surface.png") });
  await page.keyboard.press("Escape");

  // And deleting it takes the canvas and the row with it.
  await runTool(page, "Delete it.", "applet_delete", {
    appletId: await appletIdFromSurface(page),
  });
  await expect(
    page.getByRole("region", { name: /Applet Weekly Todos/ }),
  ).toHaveCount(0);
});

/** The Applet's id, read from the list page the Package itself renders. */
async function appletIdFromSurface(page: Page): Promise<string> {
  const response = await page.request.get("/api/applets");
  const body = (await response.json()) as {
    applets: Array<{ appletId: string; displayName: string }>;
  };
  const applet = body.applets.find(
    (candidate) => candidate.displayName === "Weekly Todos",
  );
  if (!applet) throw new Error("the Applet directory has no Weekly Todos");
  return applet.appletId;
}

test("the Applets canvas is a full-height sheet on a phone", async ({
  page,
  userId,
  ollamaBaseUrl,
}, testInfo: TestInfo) => {
  await page.setViewportSize(PHONE);
  await provisionThroughUi(page, {
    userId,
    apiKey: E2E_OLLAMA_GOOD_API_KEY,
    apiBaseUrl: ollamaBaseUrl,
    botName: "Builder",
  });

  await runTool(page, "Build me a todo list.", "applet_create", {
    displayName: "Weekly Todos",
  });

  // On a phone the panel starts closed: the focused Applet is a chip on the
  // composer, not a screen the User did not ask for.
  const chip = page.getByRole("button", { name: /Applet: Weekly Todos/ });
  await expect(chip).toBeVisible({ timeout: 60_000 });
  await expectNoHorizontalOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath("applets-phone-chip-real.png"),
  });

  await chip.click();
  const canvas = page.getByRole("region", { name: /Applet Weekly Todos/ });
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(PHONE.width - 24);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath("applets-phone-real.png"),
  });
});
