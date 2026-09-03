// What the product says when a request fails.
//
// Incident 1 is the header of `fixtures.ts`: a client that read every response
// with `response.json()` turned a 502 whose body was an HTML error page into
// `Unexpected token '<', "<html><bod"... is not valid JSON`, rendered that in
// the sidebar, and — because the failed read resolved the Bot list to an empty
// array — told a User who owns Bots that they had none and offered to make
// their first. A transport failure must never look like data loss, and a
// parser's complaint about its own input is never a sentence to show anyone.
//
// These are the three failures worth provoking from the browser: a deployment
// that answers with something that is not JSON, a send that is refused, and a
// Turn that dies at the provider.
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
  E2E_MODEL_LABEL,
  E2E_CONNECTION_LABEL,
} from "./fixtures.ts";
import { E2E_OLLAMA_GOOD_API_KEY } from "./harness.ts";
import type { Page } from "@playwright/test";

/** A User with one Bot and a working model, which every case here starts from. */
async function withOneBot(
  page: Page,
  userId: string,
  ollamaBaseUrl: string,
  name: string,
): Promise<void> {
  await openApplication(page, userId);
  await firstRunDialog(page).getByRole("button", { name: "Cancel" }).click();
  await connectOllama(page, {
    apiKey: E2E_OLLAMA_GOOD_API_KEY,
    apiBaseUrl: ollamaBaseUrl,
  });
  await expect(
    ollamaCard(page).getByText("ready · models fresh"),
  ).toBeVisible();
  await closeOverlay(page);
  await chooseDefaultModel(
    page,
    `${E2E_MODEL_LABEL} — ${E2E_CONNECTION_LABEL}`,
  );
  await createBot(page, name);
  await expect(
    page.getByRole("heading", { name: `${name} is ready.` }),
  ).toBeVisible();
}

test.describe("failed requests", () => {
  // Every case below provokes failures on purpose, so the fixture is told
  // which ones to expect rather than being switched off.
  test.use({
    allowedFailures: {
      console: [/Failed to load resource/u, /50\d/u],
      requests: [/\/api\//u],
    },
  });

  test("an HTML error body never becomes a parse error or a lost flock", async ({
    page,
    userId,
    ollamaBaseUrl,
  }) => {
    await withOneBot(page, userId, ollamaBaseUrl, "Gateway");

    // What a proxy, a captive portal or a cold deployment answers with: the
    // right status, and a body no JSON parser will take.
    await page.route("**/api/**", (route) =>
      route.fulfill({
        status: 502,
        contentType: "text/html",
        body: "<html><body>Bad gateway</body></html>",
      }),
    );
    await page.reload();

    const sidebar = page.locator(".sidebar");
    await expect(sidebar.locator(".flock-error")).toContainText(
      "Couldn't load your Bots",
    );
    // The two sentences this failure used to produce, neither of which is
    // true: one about this client's parser, one about the User's own data.
    await expect(page.locator("body")).not.toContainText("valid JSON");
    await expect(page.locator("body")).not.toContainText("Unexpected token");
    await expect(page.locator("body")).not.toContainText("No Bots yet");

    // And the read is offered again, rather than left as a dead end.
    await page.unroute("**/api/**");
    await sidebar.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByRole("button", { name: /Gateway/u })).toBeVisible();
    await expect(sidebar.locator(".flock-error")).toHaveCount(0);
  });

  test("a refused send keeps the draft and says so once", async ({
    page,
    userId,
    ollamaBaseUrl,
  }) => {
    await withOneBot(page, userId, ollamaBaseUrl, "Refused");

    // Only the submission itself fails. The admission lookup that follows is
    // left alone, so the client can establish what it always can here: that
    // the Turn never started.
    await page.route("**/api/**", async (route, request) => {
      const url = new URL(request.url());
      if (request.method() === "POST" && url.pathname.endsWith("/turns")) {
        await route.fulfill({
          status: 502,
          contentType: "text/html",
          body: "<html><body>Bad gateway</body></html>",
        });
        return;
      }
      await route.fallback();
    });

    const composer = composerInput(page);
    await composer.fill("does this survive");
    await page.getByRole("button", { name: "Send message" }).click();

    // One line, in the product's own words, and no bubble pretending the Bot
    // said "Turn was not admitted." to the User whose text was thrown away.
    await expect(page.locator(".message-system-line").last()).toHaveText(
      "Your message didn't go through. Try again.",
      { timeout: 30_000 },
    );
    await expect(page.locator(".thread")).not.toContainText("admitted");
    await expect(page.locator(".message-assistant")).toHaveCount(0);

    // And the retry is the message itself, back where it was typed.
    await expect(composer).toHaveValue("does this survive");
  });
});
