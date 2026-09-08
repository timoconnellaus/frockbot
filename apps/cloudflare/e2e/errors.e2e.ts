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
// The Flutter client's sentences are its own: `NativeApi.request` maps the
// status to copy before anything above it sees a body at all, which is the
// structural reason the parser can no longer speak here. So these cases assert
// what this client says — not the words the Vue one used — and the claim they
// keep is the one that mattered: never a parser's complaint, never a lie about
// the flock, and never a draft thrown away.
import {
  test,
  expect,
  composerInput,
  createBot,
  expectReadyToSend,
  openApplication,
  press,
  sem,
  transcriptMessages,
} from "./fixtures.ts";
import type { Locator, Page } from "@playwright/test";

/**
 * A User with one Bot, which every case here starts from.
 *
 * No provider is connected: the account's model is the platform's own, which
 * is what a new account has. Nothing below reaches a model anyway — both cases
 * fabricate their failure in front of the gateway — so connecting one would
 * only be a slower way to arrive at a Bot that can be sent to.
 */
async function withOneBot(
  page: Page,
  userId: string,
  botName: string,
): Promise<void> {
  await openApplication(page, userId);
  await createBot(page, botName);
  await expectReadyToSend(page);
}

/**
 * The words a person reads, wherever the engine put them.
 *
 * Flutter gives a leaf its text as the element's own content, but a sentence
 * drawn inside a container reaches the accessibility tree as that container's
 * `aria-label` and has no text node of its own. Both failure lines below are
 * the second kind, so they are named by label rather than by text.
 */
function spoken(scope: Page | Locator, copy: string): Locator {
  return scope.getByLabel(copy, { exact: true });
}

/**
 * What `NativeApi.request` says about a 5xx, and what the sidebar therefore
 * shows: one sentence the product wrote, chosen from the status alone.
 */
const REQUEST_FAILURE_COPY =
  "FrockBot couldn’t complete that request. Please try again.";

/**
 * What the conversation says when a submission never became a Turn. The client
 * establishes that by looking the run up rather than by trusting the POST that
 * failed, so this is the sentence at the end of that check.
 */
const SEND_FAILURE_COPY =
  "Your message didn’t go through. You can send it again.";

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
  }) => {
    await withOneBot(page, userId, "Gateway");

    // What a proxy, a captive portal or a cold deployment answers with: the
    // right status, and a body no JSON parser will take.
    await page.route("**/api/**", (route) =>
      route.fulfill({
        status: 502,
        contentType: "text/html",
        body: "<html><body>Bad gateway</body></html>",
      }),
    );
    // The shell adopts its cached directory before the read that fails, so a
    // client that already knows this flock never has to say anything. Clearing
    // the cache is the state this case is about: someone opening the app where
    // nothing local can answer for the deployment.
    await page.evaluate(() => localStorage.clear());
    await page.reload();

    const sidebar = sem(page, "shell-sidebar");
    await expect(spoken(sidebar, REQUEST_FAILURE_COPY)).toBeVisible();
    // The two sentences this failure used to produce, neither of which is
    // true: one about this client's parser, one about the User's own data.
    await expect(page.locator("body")).not.toContainText("valid JSON");
    await expect(page.locator("body")).not.toContainText("Unexpected token");
    await expect(page.locator("body")).not.toContainText("No Bots yet");

    // And the read is offered again, rather than left as a dead end.
    await page.unroute("**/api/**");
    await press(sem(sidebar, "sidebar-retry"));
    await expect(
      sidebar.getByRole("button", { name: /Gateway/u }),
    ).toBeVisible();
    await expect(spoken(sidebar, REQUEST_FAILURE_COPY)).toHaveCount(0);
  });

  test("a refused send keeps the draft and says so once", async ({
    page,
    userId,
  }) => {
    await withOneBot(page, userId, "Refused");

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
    // Typed rather than filled: a Flutter field's `<input>` is live only while
    // the engine holds an editing session on it, so a value written straight
    // onto the element is read back by the spec and ignored by the client —
    // and Send stays disabled over a composer that looks full.
    await composer.click();
    await composer.pressSequentially("does this survive");
    await expect(composer).toHaveValue("does this survive");
    await press(sem(page, "send-button"));

    // One line, in the product's own words, and no bubble at all: the Turn
    // never existed, so neither does a message pretending the Bot answered.
    await expect(spoken(page, SEND_FAILURE_COPY)).toHaveCount(1, {
      timeout: 60_000,
    });
    await expect(page.locator("body")).not.toContainText("admitted");
    await expect(transcriptMessages(page)).toHaveCount(0);

    // And the retry is the message itself, back where it was typed.
    await expect(composer).toHaveValue("does this survive");
  });
});
