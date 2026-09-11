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
//
// The receipt these tests are watching for is `_markWhatIsBeingRead` in
// `apps/native/lib/shell/app_shell.dart`: `_select` sends it when a chat is
// opened, and it is an `ActivityController` listener as well, so it sends
// again as each reply lands in the chat that is already on screen. Both halves
// of the rule are that one call, which is why a spec that only opened a chat
// would still pass with the second half missing.
import {
  test,
  expect,
  composerInput,
  createBot,
  expectReadyToSend,
  press,
  provisionThroughUi,
  revealSidebar,
  sem,
  SHELL_TIMEOUT_MS,
} from "./fixtures.ts";
import { E2E_OLLAMA_GOOD_API_KEY } from "./harness.ts";
import type { Locator, Page } from "@playwright/test";

/**
 * Wait for the sidebar's next unread poll to come back.
 *
 * A badge that is absent because nothing has looked yet proves nothing, so
 * the "no badge" assertions are made after a poll that *started* after the
 * thing they are about. The client asks `/api/bots/unread` on a ten-second
 * timer (`ActivityController.load`, driven from `app_shell.dart`); this waits
 * for the next request that timer issues and for its answer, rather than
 * sleeping for two whole periods to be sure of covering one.
 */
async function afterNextUnreadPoll(page: Page): Promise<void> {
  const request = await page.waitForRequest(
    (candidate) =>
      candidate.method() === "GET" &&
      new URL(candidate.url()).pathname === "/api/bots/unread",
    { timeout: 30_000 },
  );
  const response = await request.response();
  expect(response?.ok(), "the unread poll answered").toBe(true);
}

function botRow(page: Page, name: string): Locator {
  return sem(page, "shell-sidebar")
    .locator('[flt-semantics-identifier^="sidebar-bot-"]')
    .filter({ hasText: name });
}

/** The durable id behind a row, which the row's own identifier carries. */
async function botIdOf(page: Page, name: string): Promise<string> {
  const row = botRow(page, name);
  await expect(row).toHaveCount(1);
  const identifier = await row.getAttribute("flt-semantics-identifier");
  if (!identifier) throw new Error(`the ${name} row has no identifier`);
  return identifier.slice("sidebar-bot-".length);
}

/**
 * The unread badge, which is a number at the end of a row and nothing else.
 *
 * A `ListTile` merges everything it draws into one semantics node, so the
 * badge is not a node a spec can select: it is the last thing in the row's own
 * text, after the name, the time and the preview of the last message. Nothing
 * else there ends in a digit — the fake provider's reply ends in a full stop
 * and a Bot with no messages ends in a word — so a trailing number is the
 * badge.
 */
const BADGE = /\s\d+\+?$/u;

async function expectBadge(page: Page, name: string, count: string) {
  await expect(botRow(page, name)).toContainText(
    new RegExp(`\\s${count}$`, "u"),
    { timeout: 120_000 },
  );
}

async function expectNoBadge(page: Page, name: string): Promise<void> {
  await expect(botRow(page, name)).not.toContainText(BADGE);
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
  await expectReadyToSend(page);

  // Alpha is the chat the User is reading, and Beta is the Bot nobody is
  // looking at.
  await revealSidebar(page);
  await botRow(page, "Alpha").click();
  await expectReadyToSend(page);
  const beta = await botIdOf(page, "Beta");

  // Beta's Turn is started from outside this browser rather than typed into
  // the composer and outrun. A message typed into the composer is a message
  // typed into the chat that is open, so the old way was to hold the provider
  // open with `slow` and switch chats before it answered — a race the read
  // receipt now decides, because a reply that beats the switch is marked read
  // on arrival and never badges anything. Starting the Turn once the User has
  // already left has no such window, and it is how a Turn reaches a Bot in the
  // real product anyway: a Routine, a webhook, another device.
  const turn = await page.request.post(
    `/api/bots/${encodeURIComponent(beta)}/turns`,
    {
      data: {
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        text: "Answer me while nobody is looking",
      },
    },
  );
  expect(turn.ok(), "the Turn was admitted").toBe(true);

  // Beta's reply lands somewhere nobody is looking: its row goes unread.
  await expectBadge(page, "Beta", "1");
  // And the chat the User is actually reading is left alone.
  await expectNoBadge(page, "Alpha");

  // Opening the chat clears it — immediately, without waiting for a poll.
  await botRow(page, "Beta").click();
  await expectNoBadge(page, "Beta");

  // Durably: "read" is a cursor on the Bot, not something this page remembered.
  // Alpha is put back in front first, so Beta's quiet row is the durable
  // record answering rather than the focus rule suppressing its own badge.
  await page.reload();
  await expect(sem(page, "shell-sidebar")).toBeVisible({
    timeout: SHELL_TIMEOUT_MS,
  });
  await revealSidebar(page);
  await botRow(page, "Alpha").click();
  await expectReadyToSend(page);
  await expectNoBadge(page, "Beta");
  // Still gone a full poll later, rather than reappearing on the next fan-out.
  await afterNextUnreadPoll(page);
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
  await expectReadyToSend(page);
  await revealSidebar(page);
  await botRow(page, "Alpha").click();
  await expectReadyToSend(page);

  // A Flutter input is a live editing element only while the engine holds an
  // editing session open on it, so the words go in as keystrokes.
  const composer = composerInput(page);
  await composer.click();
  await composer.pressSequentially("Say something back");
  await expect(composer).toHaveValue("Say something back");
  await press(sem(page, "send-button"));
  await expect(composer).toHaveValue("", { timeout: 120_000 });

  // The Bot Durable Object counted this Turn — it has to, it cannot see the
  // screen — so the only thing keeping the row quiet is the focus rule and the
  // read receipt behind it. The Turn has to have settled, and a poll has to
  // have run since, for that to mean anything.
  await expect(sem(page, "working-indicator")).toHaveCount(0, {
    timeout: 120_000,
  });
  await afterNextUnreadPoll(page);
  await expectNoBadge(page, "Alpha");
  await expectNoBadge(page, "Beta");

  // And it is still quiet after a reload with Beta in front — which is the
  // durable receipt answering, not the focus rule hiding Alpha's own badge.
  await page.reload();
  await expect(sem(page, "shell-sidebar")).toBeVisible({
    timeout: SHELL_TIMEOUT_MS,
  });
  await revealSidebar(page);
  await botRow(page, "Beta").click();
  await expectReadyToSend(page);
  await expectNoBadge(page, "Alpha");
});
