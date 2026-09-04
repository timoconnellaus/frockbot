// The phone layout.
//
// The hosted WebUI is the product UI on every platform (`AGENTS.md`, "One
// production path"), so the phone is not a separate client: it is this same
// bundle at a 390pt viewport. What that costs the layout is measurable, and
// this spec measures it rather than eyeballing it — nothing may overflow the
// viewport horizontally, the composer must stay reachable, and the two columns
// a phone has no room for (the Bot list and the right panel) must be reachable
// as drawers.
//
// It also writes the screenshots that stand as the visual record of the layout,
// into Playwright's output directory.
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  test,
  expect,
  openApplication,
  firstRunDialog,
  connectOllama,
  closeOverlay,
  chooseDefaultModel,
  createBot,
  ollamaCard,
  composerInput,
  sendMessage,
  setFakeOllamaChatMode,
  E2E_MODEL_LABEL,
  E2E_CONNECTION_LABEL,
} from "./fixtures.ts";
import { E2E_OLLAMA_GOOD_API_KEY } from "./harness.ts";
import type { Page } from "@playwright/test";

/** A 2019-and-later iPhone in portrait: the narrowest viewport worth serving. */
const PHONE = { width: 390, height: 844 } as const;
const SAFE_TOP = 32;
const SAFE_BOTTOM = 24;

test.use({ viewport: PHONE, deviceScaleFactor: 2, hasTouch: true });

async function emulateNativeSafeArea(page: Page): Promise<void> {
  await page.addInitScript(
    ({ top, bottom }) => {
      document.addEventListener(
        "DOMContentLoaded",
        () => {
          document.documentElement.style.setProperty(
            "--safe-area-inset-top",
            `${top}px`,
          );
          document.documentElement.style.setProperty(
            "--safe-area-inset-bottom",
            `${bottom}px`,
          );
        },
        { once: true },
      );
    },
    { top: SAFE_TOP, bottom: SAFE_BOTTOM },
  );
}

const shotDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "test-results",
  "mobile",
);

/**
 * Wait for every drawer that is moving to arrive.
 *
 * Both drawers slide, so a box measured on the frame after the click is a box
 * part-way across the window, and a screenshot taken there is of a layout that
 * exists for 220ms. Only transitions are waited on: an animation may be
 * infinite — the Bot avatar breathes while a Turn runs — and waiting for one of
 * those to stop would never return.
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

/**
 * Nothing is wider than the window.
 *
 * A phone layout fails first as a sideways scrollbar: one column that kept its
 * desktop width pushes everything else off the screen. The document is the
 * outer measure; the thread is the inner one, because content the conversation
 * cannot wrap — a long path, a wide code block — overflows inside it while the
 * document still looks clean.
 *
 * The shell itself is deliberately not measured. A closed drawer is parked
 * outside the window on purpose, and a transformed descendant counts towards
 * its ancestor's overflow region even though `.frockbot-root` clips it away.
 */
async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const measure = (
      selector: string,
    ): { overflow: number; scrolled: number } => {
      const element = document.querySelector(selector);
      if (!element) return { overflow: 0, scrolled: 0 };
      return {
        overflow: element.scrollWidth - element.clientWidth,
        scrolled: element.scrollLeft,
      };
    };
    /*
     * A parked drawer still counts as layout overflow, which is fine as long
     * as nothing can scroll to it. Asking for the scroll is the only honest
     * test of that: a clipped element refuses and stays at zero, a hidden one
     * accepts and takes the layout with it.
     */
    const root = document.querySelector(".frockbot-root");
    let rootScrolledAfterPush = 0;
    if (root) {
      root.scrollLeft = 999;
      rootScrolledAfterPush = root.scrollLeft;
      root.scrollLeft = 0;
    }
    return {
      document:
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
      root: measure(".frockbot-root"),
      rootScrolledAfterPush,
      thread: measure(".thread"),
    };
  });
  expect(
    overflow.document,
    "the document overflows sideways",
  ).toBeLessThanOrEqual(0);
  // The root clips rather than scrolls, so a parked drawer can never be
  // scrolled into view — which would drag the whole layout sideways with it,
  // and did: focusing the composer was enough to do it.
  expect(overflow.root.scrolled, "the shell is scrolled sideways").toBe(0);
  expect(
    overflow.rootScrolledAfterPush,
    "the shell can be scrolled sideways",
  ).toBe(0);
  expect(
    overflow.thread.overflow,
    "the conversation overflows sideways",
  ).toBeLessThanOrEqual(0);
}

/** Every part of an element is inside the viewport. */
async function expectWithinViewport(
  page: Page,
  selector: string,
  label: string,
): Promise<void> {
  await settle(page);
  const box = await page.locator(selector).first().boundingBox();
  expect(box, `${label} has no box`).not.toBeNull();
  if (!box) return;
  expect(box.x, `${label} starts left of the viewport`).toBeGreaterThanOrEqual(
    -1,
  );
  expect(
    box.x + box.width,
    `${label} runs past the right edge`,
  ).toBeLessThanOrEqual(PHONE.width + 1);
}

test("the shell is usable on a phone", async ({
  page,
  userId,
  ollamaBaseUrl,
}) => {
  await emulateNativeSafeArea(page);
  await openApplication(page, userId);
  await shot(page, "01-first-run-dialog");
  await expectNoHorizontalOverflow(page);
  await firstRunDialog(page).getByRole("button", { name: "Cancel" }).click();

  // The Bot list and the sidebar actions live behind the navigation drawer on a
  // phone, so reaching any of them is itself a test of the drawer. The
  // provisioning helpers open it for themselves; this one call is here to
  // photograph it and to prove it opens on its own account.
  await openNavigation(page);
  await shot(page, "02-navigation-drawer");
  await expectNoHorizontalOverflow(page);
  await closeNavigation(page);

  // Enablement on Plugins, setup on Models: two surfaces, and on a phone the
  // drawer closes behind each of them.
  await connectOllama(page, {
    apiKey: E2E_OLLAMA_GOOD_API_KEY,
    apiBaseUrl: ollamaBaseUrl,
  });
  await expect(
    ollamaCard(page).getByText("ready · models fresh"),
  ).toBeVisible();
  await shot(page, "03-models-surface");
  await expectNoHorizontalOverflow(page);
  await closeOverlay(page);

  await chooseDefaultModel(
    page,
    `${E2E_MODEL_LABEL} — ${E2E_CONNECTION_LABEL}`,
  );

  await createBot(page, "Pocket");
  await expect(
    page.getByRole("heading", { name: "Pocket is ready." }),
  ).toBeVisible();
  await expect(composerInput(page)).toBeEnabled();
  await shot(page, "04-empty-thread");
  await expectNoHorizontalOverflow(page);
  await expectWithinViewport(page, ".composer", "the composer");
  await expectWithinViewport(page, ".topbar", "the topbar");
  const safeLayout = await page.evaluate(() => {
    const topbar = document.querySelector(".topbar")!.getBoundingClientRect();
    const menu = document.querySelector(".nav-toggle")!.getBoundingClientRect();
    const thread = document.querySelector(".thread")!.getBoundingClientRect();
    const composer = document
      .querySelector(".composer")!
      .getBoundingClientRect();
    return {
      topbarHeight: topbar.height,
      menuTop: menu.top,
      threadTop: thread.top,
      composerBottom: composer.bottom,
    };
  });
  expect(safeLayout.topbarHeight).toBe(52 + SAFE_TOP);
  expect(safeLayout.menuTop).toBeGreaterThanOrEqual(SAFE_TOP);
  expect(safeLayout.threadTop).toBe(52 + SAFE_TOP);
  expect(safeLayout.composerBottom).toBeLessThanOrEqual(
    PHONE.height - SAFE_BOTTOM,
  );

  // Choosing a Bot is what the drawer is for, so it closes behind the choice
  // rather than covering the conversation it just opened.
  await expect(page.locator(".sidebar")).toBeHidden();

  // The fake provider's chat mode is one piece of state the whole suite
  // shares, and a spec before this one may have revoked the key to prove a
  // failing Turn. Say what this spec needs rather than inherit it.
  await setFakeOllamaChatMode(page, ollamaBaseUrl, "ok");
  await sendMessage(page, "Does this **fit** on a phone?");
  await expect(
    page.locator(".message-assistant strong", { hasText: "local Ollama stub" }),
  ).toBeVisible();
  await shot(page, "05-conversation");
  await expectNoHorizontalOverflow(page);
  // A bubble may be narrower than the thread, never wider than the window.
  await expectWithinViewport(page, ".message-user .message-bubble", "a bubble");

  /*
   * Bot settings, from the conversation, in one tap.
   *
   * This is the finding that made the phone unusable rather than cramped: the
   * gear lived in the right panel's header, the right panel is a closed drawer
   * at this width, and so Name, Label, Description, Routines, the audit log
   * and template import had no route at all on a phone. Only the panel's own
   * toggle survived into the header, which is why the pair read wrongly. The
   * toggle stays — it is how the panel opens at this width — and the gear is
   * now beside it, reachable with nothing else open.
   */
  await expect(
    page.getByRole("button", { name: "Bot settings" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Bot settings" }).click();
  await expect(page.getByRole("region", { name: "Settings" })).toBeVisible();
  await shot(page, "06-bot-settings-panel");
  await expectNoHorizontalOverflow(page);
  await expectWithinViewport(page, ".panel-surface-view", "the panel surface");
  const settingsHeader = await page
    .locator(".panel-surface-header")
    .boundingBox();
  expect(settingsHeader).not.toBeNull();
  expect(settingsHeader!.height).toBe(52 + SAFE_TOP);
  // Named, so the User can tell whose settings these are.
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Pocket");

  // The panel the surface took the place of is where its own back control
  // leads: the third column, full width over the conversation.
  await page.getByRole("button", { name: "Back to Bot panel" }).click();
  await shot(page, "07-right-panel");
  await expectNoHorizontalOverflow(page);
  await expectWithinViewport(page, ".right-panel", "the right panel");

  // And Escape gives the conversation the whole window back.
  await page.keyboard.press("Escape");
  await expect(page.locator(".right-panel")).toBeHidden();

  /*
   * A closed overlay leaves nothing over the window.
   *
   * The scrim behind a hosted surface is a full-window element, so a scrim
   * that outlives its panel is invisible and total: every later click lands on
   * it instead of on what the person aimed at, and the only symptom is a test
   * — or a User — waiting on a control that is plainly there. Opening a
   * surface, closing it, and then using the Bot list is the cheapest proof
   * that the layer went away.
   */
  await openNavigation(page);
  await page
    .getByRole("button", { name: /Search/u })
    .first()
    .click();
  await expect(page.getByRole("region", { name: "Search" })).toBeVisible();
  // The scrim dims what the surface covers and takes no clicks of its own, so
  // the workspace behind it stays live while it is open.
  await expect(page.locator(".ui-sidebar-overlay__scrim")).toHaveCSS(
    "pointer-events",
    "none",
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("region", { name: "Search" })).toBeHidden();
  await expect(page.locator(".ui-sidebar-overlay__scrim")).toHaveCount(0);

  // The proof is that the click lands at all: a surviving scrim swallows it
  // and the row simply never answers.
  await openNavigation(page);
  await page
    .getByRole("button", { name: /Pocket/u })
    .first()
    .click({ timeout: 15_000 });
  await closeNavigation(page);
  await expect(composerInput(page)).toBeEnabled();
});

test("the sign-in page clears the native system bars", async ({ page }) => {
  // This is a layout test for the public shell. Keep it independent of the
  // e2e harness's Better Auth upstream, which is deliberately not configured.
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({ json: null }),
  );
  await emulateNativeSafeArea(page);
  await page.goto("/");
  await expect(page.locator(".auth-screen")).toBeVisible();
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute(
    "content",
    /viewport-fit=cover/,
  );

  const padding = await page.locator(".auth-screen").evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      top: Number.parseFloat(style.paddingTop),
      bottom: Number.parseFloat(style.paddingBottom),
      background: style.backgroundColor,
    };
  });
  expect(padding.top).toBe(32 + SAFE_TOP);
  expect(padding.bottom).toBe(32 + SAFE_BOTTOM);
  expect(padding.background).not.toBe("rgba(0, 0, 0, 0)");
});

/** Open the navigation drawer and prove it arrived. */
async function openNavigation(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Show navigation" }).click();
  await expect(page.locator(".sidebar")).toBeVisible();
}

/**
 * Close it by tapping the conversation behind it, which is the way back a
 * person reaches for before they look for a control.
 *
 * The tap is offset deliberately. The scrim covers the window, so its centre
 * is behind the drawer; what a person actually taps is the strip of
 * conversation still showing beside it, and that is the gesture worth
 * proving.
 */
async function closeNavigation(page: Page): Promise<void> {
  await page
    .locator(".nav-scrim")
    .click({ position: { x: PHONE.width - 20, y: PHONE.height / 2 } });
  await expect(page.locator(".sidebar")).toBeHidden();
}
