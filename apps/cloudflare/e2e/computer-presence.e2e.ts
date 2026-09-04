// The right-panel Computer card and minimal hosted viewer (P1–P4). The browser
// routes stand in for the unavailable Computer host and Sprite origin while
// the shell, client state machine, confirmation, iframe sandbox and fragment
// takeover path remain the production implementation.
import type { Page } from "@playwright/test";
import {
  test,
  expect,
  assistantMessages,
  composerInput,
  provisionThroughUi,
  setFakeOllamaChatMode,
} from "./fixtures.ts";
import { E2E_OLLAMA_GOOD_API_KEY } from "./harness.ts";

const viewerUrl =
  "https://fake.sprites.app/index.html#autoconnect=1&reconnect=1&resize=scale&view_only=1&path=websockify%3Ftoken%3Dfake-viewer-token&password=fake-password";

async function installFakeComputer(page: Page): Promise<void> {
  let controlHeld = false;
  await page.route(
    /\/api\/bots\/[^/]+\/computer(\/commands)?(\?.*)?$/,
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const botId = decodeURIComponent(
        /\/api\/bots\/([^/]+)\/computer/.exec(url.pathname)?.[1] ?? "unknown",
      );
      if (url.pathname.endsWith("/commands")) {
        const command = request.postDataJSON() as {
          commandId: string;
          type: "takeControl" | "releaseControl" | string;
        };
        if (command.type === "takeControl") controlHeld = true;
        if (command.type === "releaseControl") controlHeld = false;
        await route.fulfill({
          json: {
            version: 1,
            commandId: command.commandId,
            type: command.type,
            status: "applied",
            completedAt: "2026-09-03T00:00:00.000Z",
          },
        });
        return;
      }
      await route.fulfill({
        json: {
          version: 1,
          botId,
          providerLabel: "Fake Sprite",
          phase: controlHeld ? "human-control" : "ready",
          message: controlHeld
            ? "You have control. Release when finished with private data."
            : "Computer ready",
          viewerSession: {
            version: 1,
            id: "fake-viewer-token",
            url: viewerUrl,
            expiresAt: "2099-09-03T00:01:30.000Z",
          },
          ...(controlHeld
            ? {
                controlLease: {
                  version: 1,
                  ownerId: "human:e2e",
                  acquiredAt: "2026-09-03T00:00:00.000Z",
                  expiresAt: "2099-09-03T00:01:30.000Z",
                },
              }
            : {}),
          screenshots: [],
        },
      });
    },
  );
  await page.route("https://fake.sprites.app/index.html", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html>
        <html><body data-view-only="true">
          <p id="state">Desktop connected</p>
          <button id="desktop" type="button">Desktop target</button>
          <output id="clicks">0</output>
          <script>
            const applyMode = () => {
              const params = new URLSearchParams(location.hash.slice(1));
              document.body.dataset.viewOnly = params.get("view_only") !== "0" ? "true" : "false";
            };
            applyMode();
            addEventListener("hashchange", applyMode);
            desktop.addEventListener("pointerup", (event) => {
              if (document.body.dataset.viewOnly === "false" && event.pointerType === "touch") {
                clicks.value = String(Number(clicks.value) + 1);
              }
            });
            parent.postMessage({ type: "frockbot-viewer", state: "connected", message: "Desktop connected" }, "*");
          </script>
        </body></html>`,
    }),
  );
}

test("the right-panel card shows the Computer and expands on first click", async ({
  page,
  userId,
  ollamaBaseUrl,
}) => {
  await page.setViewportSize({ width: 1351, height: 859 });
  await installFakeComputer(page);
  await provisionThroughUi(page, {
    userId,
    apiKey: E2E_OLLAMA_GOOD_API_KEY,
    apiBaseUrl: ollamaBaseUrl,
    botName: "Watched",
  });

  const panel = page.getByRole("region", { name: "Bot panel" });
  const card = panel.getByRole("button", {
    name: "Open computer in full window",
  });
  await expect(card).toBeVisible();
  await page.screenshot({
    path: "e2e/test-results/computer-presence-desktop.png",
  });

  // The first click only expands a view-only frame.
  await card.click();
  const overlay = page.locator(".computer-overlay");
  await expect(overlay.first()).toBeVisible();
  const frame = page.frameLocator('iframe[title="Computer"]');
  await expect(frame.locator("body")).toHaveAttribute("data-view-only", "true");
  await expect(frame.locator(".noVNC_control_bar")).toHaveCount(0);

  // The second click is confirmed. Only the fragment changes, the framed page
  // observes it live, and a touch pointer reaches the desktop target.
  await page.getByRole("button", { name: "Take control" }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Take control" })
    .click();
  await expect(frame.locator("body")).toHaveAttribute(
    "data-view-only",
    "false",
  );
  await frame
    .getByRole("button", { name: "Desktop target" })
    .dispatchEvent("pointerup", { pointerType: "touch" });
  await expect(frame.locator("#clicks")).toHaveText("1");
  await page.screenshot({
    path: "e2e/test-results/computer-presence-expanded.png",
  });
  await page.keyboard.press("Escape");
  await expect(overlay.first()).toBeHidden();

  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test("the right-panel Computer card fits the mobile shell", async ({
  page,
  userId,
  ollamaBaseUrl,
}) => {
  await installFakeComputer(page);
  await provisionThroughUi(page, {
    userId,
    apiKey: E2E_OLLAMA_GOOD_API_KEY,
    apiBaseUrl: ollamaBaseUrl,
    botName: "Pocket",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  // The shell re-lays out after the resize; open the right-panel drawer only
  // once its mobile toggle exists.
  await expect(
    page.getByRole("button", { name: "Show navigation" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Show side panel" }).click();
  const panel = page.getByRole("region", { name: "Bot panel" });
  const card = panel.getByRole("button", {
    name: "Open computer in full window",
  });
  await expect(card).toBeVisible();
  await card.click();
  await expect(page.locator(".computer-overlay")).toBeVisible();
  await page.getByRole("button", { name: "Take control" }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Take control" })
    .click();
  const frame = page.frameLocator('iframe[title="Computer"]');
  await expect(frame.locator("body")).toHaveAttribute(
    "data-view-only",
    "false",
  );
  await frame
    .getByRole("button", { name: "Desktop target" })
    .dispatchEvent("pointerup", { pointerType: "touch" });
  await expect(frame.locator("#clicks")).toHaveText("1");
  await page.screenshot({
    path: "e2e/test-results/computer-presence-mobile.png",
  });
});

test("the card shows the Bot working live and settles back to a snapshot", async ({
  page,
  userId,
  ollamaBaseUrl,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1351, height: 859 });
  await installFakeComputer(page);
  await provisionThroughUi(page, {
    userId,
    apiKey: E2E_OLLAMA_GOOD_API_KEY,
    apiBaseUrl: ollamaBaseUrl,
    botName: "Working",
  });

  const panel = page.getByRole("region", { name: "Bot panel" });
  const card = panel.getByRole("button", {
    name: "Open computer in full window",
  });
  await expect(card).toBeVisible();
  const live = page.locator('iframe[title="Computer, live"]');
  // A Bot with nothing to do holds no stream.
  await expect(live).toHaveCount(0);

  // A Turn that takes its time is the whole point: the User watches it happen.
  await setFakeOllamaChatMode(page, ollamaBaseUrl, "slow");
  const replies = assistantMessages(page);
  const before = await replies.count();
  const composer = composerInput(page);
  await composer.fill("Do something on the computer");
  await page.getByRole("button", { name: "Send message" }).click();

  await expect(live).toBeVisible({ timeout: 60_000 });
  // The card watches; it never types. The framed viewer is the same one the
  // full-screen overlay uses, minted view-only, with no takeover lease.
  await expect(
    page.frameLocator('iframe[title="Computer, live"]').locator("body"),
  ).toHaveAttribute("data-view-only", "true");
  await expect(page.locator(".computer-screen-status")).toHaveText("Live");
  await expect(page.locator(".computer-overlay")).toHaveCount(0);
  await page.screenshot({
    path: "e2e/test-results/computer-presence-live.png",
  });

  // Clicking the live card still opens the full-screen viewer, unchanged.
  await card.click();
  await expect(page.locator(".computer-overlay").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".computer-overlay")).toHaveCount(0);

  await setFakeOllamaChatMode(page, ollamaBaseUrl, "ok");
  await expect(replies).toHaveCount(before + 1, { timeout: 120_000 });
  // The stream outlives the Turn by a short grace window and then lapses, so
  // an idle Bot stops holding a connection to its desktop.
  await expect(live).toHaveCount(0, { timeout: 60_000 });
  await expect(page.locator(".computer-screen-status")).toHaveCount(0);
});
