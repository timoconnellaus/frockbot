// The rule, in a browser:
//
//   "This is one notification per message for a bot that is out of focus. If I
//    have the bot open then that shouldn't raise a notification (or a badge on
//    the list of bots). And when I open a chat that should clear the badge /
//    notification."
//
// The unit tests own the arithmetic and the Workerd test owns the durable
// cursor. What only a browser can show is the three parts joining up: a Bot
// that settles a Turn while a *different* chat is open badges its own row and
// not the open one, opening it clears that badge for good, and a reply that
// lands in the chat the User is reading never raises a badge at all — not even
// for the beat between the fan-out returning and the read receipt landing,
// which is the flicker that made the old behaviour wrong.
import {
  test,
  expect,
  composerInput,
  createBot,
  provisionThroughUi,
  revealSidebar,
  sendMessage,
  setFakeOllamaChatMode,
} from "./fixtures.ts";
import { E2E_OLLAMA_GOOD_API_KEY } from "./harness.ts";
import type { Locator, Page } from "@playwright/test";

/**
 * Longer than the sidebar's 15-second unread poll.
 *
 * A badge that is absent because nothing has looked yet proves nothing, so the
 * "no badge" assertions wait past a full poll before they are made. The number
 * mirrors `UNREAD_POLL_INTERVAL_MS` in the Flock client.
 */
const PAST_ONE_UNREAD_POLL_MS = 20_000;

function botRow(page: Page, name: string): Locator {
  return page.locator(".flock-bot-row").filter({ hasText: name });
}

/** Every way the sidebar says "unread", asked at once. */
async function expectNoBadge(page: Page, name: string): Promise<void> {
  const row = botRow(page, name);
  await expect(row).not.toHaveClass(/unread/u);
  await expect(row.locator(".flock-unread-badge")).toHaveCount(0);
}

test("a Bot that replies while another chat is open badges only its own row", async ({
  page,
  userId,
  ollamaBaseUrl,
}) => {
  // Saving a Bot's settings asks the browser for notification permission, and
  // a granted permission is also what lets the background intent be delivered
  // and acknowledged rather than waiting forever for an answer.
  await page.context().grantPermissions(["notifications"]);
  await provisionThroughUi(page, {
    userId,
    apiKey: E2E_OLLAMA_GOOD_API_KEY,
    apiBaseUrl: ollamaBaseUrl,
    botName: "Alpha",
  });
  await createBot(page, "Beta");
  await expect(
    page.getByRole("heading", { name: "Beta is ready." }),
  ).toBeVisible();

  // A Bot cannot reply to nobody, so the Turn is started in Beta and then left
  // running while the User moves to Alpha: `slow` holds the completion open
  // long enough for the switch, and the reply settles on a Bot whose chat is
  // no longer the open one — exactly the case the rule is about.
  await setFakeOllamaChatMode(page, ollamaBaseUrl, "slow");
  const composer = composerInput(page);
  await composer.fill("Answer me in your own time");
  await expect(composer).toHaveValue("Answer me in your own time");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(composer).toHaveValue("", { timeout: 120_000 });

  await revealSidebar(page);
  await botRow(page, "Alpha").click();
  await expect(
    page.getByRole("heading", { name: "Alpha is ready." }),
  ).toBeVisible();
  await setFakeOllamaChatMode(page, ollamaBaseUrl, "ok");

  // Beta's reply lands somewhere nobody is looking: its row goes unread.
  await expect(botRow(page, "Beta")).toHaveClass(/unread/u, {
    timeout: 120_000,
  });
  await expect(botRow(page, "Beta").locator(".flock-unread-badge")).toHaveText(
    "1",
  );
  // And the chat the User is actually reading is left alone.
  await expectNoBadge(page, "Alpha");

  // Opening the chat clears it — immediately, without waiting for a poll.
  await botRow(page, "Beta").click();
  await expectNoBadge(page, "Beta");

  // Durably: "read" is a cursor on the Bot, not something this page remembered.
  // Alpha is put back in front first, so Beta's quiet row is the durable
  // record answering rather than the focus rule suppressing its own badge.
  await page.reload();
  await revealSidebar(page);
  await botRow(page, "Alpha").click();
  await expect(
    page.getByRole("heading", { name: "Alpha is ready." }),
  ).toBeVisible();
  await expectNoBadge(page, "Beta");
  // Still gone a full poll later, rather than reappearing on the next fan-out.
  await page.waitForTimeout(PAST_ONE_UNREAD_POLL_MS);
  await expectNoBadge(page, "Beta");
  await expectNoBadge(page, "Alpha");
});

test("a reply in the chat the User is reading never raises a badge", async ({
  page,
  userId,
  ollamaBaseUrl,
}) => {
  await page.context().grantPermissions(["notifications"]);
  await provisionThroughUi(page, {
    userId,
    apiKey: E2E_OLLAMA_GOOD_API_KEY,
    apiBaseUrl: ollamaBaseUrl,
    botName: "Alpha",
  });
  await createBot(page, "Beta");
  await expect(
    page.getByRole("heading", { name: "Beta is ready." }),
  ).toBeVisible();
  await revealSidebar(page);
  await botRow(page, "Alpha").click();
  await expect(composerInput(page)).toBeEnabled();

  await sendMessage(page, "Say something back");

  // The Bot Durable Object counted this Turn — it has to, it cannot see the
  // screen — so the only thing keeping the row quiet is the focus rule and the
  // read receipt behind it. A poll has to have run for that to mean anything.
  await page.waitForTimeout(PAST_ONE_UNREAD_POLL_MS);
  await expectNoBadge(page, "Alpha");
  await expectNoBadge(page, "Beta");

  // And it is still quiet after a reload with Beta in front — which is the
  // durable receipt answering, not the focus rule hiding Alpha's own badge.
  await page.reload();
  await revealSidebar(page);
  await botRow(page, "Beta").click();
  await expect(
    page.getByRole("heading", { name: "Beta is ready." }),
  ).toBeVisible();
  await expectNoBadge(page, "Alpha");
});
