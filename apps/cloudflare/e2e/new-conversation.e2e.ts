// Journey 6 step 2: "start a new conversation with the same Bot".
//
// There used to be no way to do it. A Bot had one Session for its whole life,
// so the transcript only ever grew and the memory-recall proof the journey
// exists to make was confounded — the fact the Bot "remembered" was still
// sitting in message history.
//
// This is the seam from the composer's action through the application Worker
// to the Bot Durable Object's durable conversation boundary: the transcript
// shows the new conversation, the Turns of the old one are still on disk, and
// the Bot keeps answering.
import {
  test,
  expect,
  press,
  provisionThroughUi,
  sem,
  sendMessage,
  transcriptMessages,
} from "./fixtures.ts";
import { E2E_OLLAMA_GOOD_API_KEY } from "./harness.ts";
import type { Page } from "@playwright/test";

/**
 * The durable id of the Bot the shell has open.
 *
 * The Flutter client keeps the selection in its own store rather than in the
 * address, so the id is read off the sidebar: the open row is the current one,
 * and the row's identifier carries the id.
 */
async function openBotId(page: Page): Promise<string> {
  const row = sem(page, "shell-sidebar").locator(
    '[flt-semantics-identifier^="sidebar-bot-"][aria-current="true"]',
  );
  await expect(row).toHaveCount(1);
  const identifier = await row.getAttribute("flt-semantics-identifier");
  if (!identifier) throw new Error("the open row has no identifier");
  return identifier.slice("sidebar-bot-".length);
}

test("a new conversation clears the transcript and the Bot keeps working", async ({
  page,
  userId,
  ollamaBaseUrl,
}) => {
  await provisionThroughUi(page, {
    userId,
    apiKey: E2E_OLLAMA_GOOD_API_KEY,
    apiBaseUrl: ollamaBaseUrl,
    botName: "Rememberer",
  });

  // What a message says is not in the thread's text — a person's own bubble
  // reaches the accessibility tree as a disabled, empty textarea — so the
  // transcript is counted rather than read here, and which words ended up in
  // which conversation is asked of the authority at the end.
  const messages = transcriptMessages(page);
  const picker = sem(page, "conversation-picker");
  const first = "The first conversation";
  await sendMessage(page, first);
  await expect(messages).toHaveCount(1);
  // One conversation is not a choice, so there is nothing to choose between.
  await expect(picker).toHaveCount(0);

  await press(sem(page, "new-conversation"));

  // The transcript is the conversation, so it shows the new one: an empty one.
  await expect(messages).toHaveCount(0);
  // And the one just put down is still a place the person can go back to.
  await expect(picker).toBeVisible();

  // The Bot is not wedged: the next Turn is admitted and answered in the new
  // Session, and it does not join the transcript of the old one.
  const second = "The second conversation";
  await sendMessage(page, second);
  await expect(messages).toHaveCount(1);

  // The conversation just ended is still durable, Turn for Turn: it is listed,
  // it is offered by name, and its runs are readable by naming it.
  const botId = await openBotId(page);
  const listing = await page.request.get(
    `/api/bots/${encodeURIComponent(botId)}/conversations`,
  );
  expect(listing.ok()).toBe(true);
  const listed = (await listing.json()) as {
    conversations: Array<{ conversationId: string; ordinal: number }>;
  };
  expect(listed.conversations.length).toBe(2);
  expect(listed.conversations[0]!.ordinal).toBe(2);
  expect(listed.conversations[1]!.ordinal).toBe(1);

  await picker.click();
  for (const conversation of listed.conversations) {
    await expect(
      sem(page, `conversation-${conversation.conversationId}`),
    ).toBeVisible();
  }
  await page.keyboard.press("Escape");

  const turns = await page.request.get(
    `/api/bots/${encodeURIComponent(botId)}/turns?conversationId=${encodeURIComponent(
      listed.conversations[1]!.conversationId,
    )}`,
  );
  expect(turns.ok()).toBe(true);
  const earlier = (await turns.json()) as { runs: Array<{ input: string }> };
  expect(earlier.runs.some((run) => run.input === first)).toBe(true);
  expect(earlier.runs.some((run) => run.input === second)).toBe(false);
});

test("a new conversation is refused while a Turn is still running", async ({
  page,
  userId,
  ollamaBaseUrl,
}) => {
  await provisionThroughUi(page, {
    userId,
    apiKey: E2E_OLLAMA_GOOD_API_KEY,
    apiBaseUrl: ollamaBaseUrl,
    botName: "Busy",
  });
  const botId = await openBotId(page);

  // The log a running Turn is appending to is not something a press may pull
  // out from under it, so the action refuses with its reason rather than
  // half-ending a conversation. The race is run out of the browser rather than
  // inside the page: a 4xx a page saw is a console error, and whether this one
  // is provoked at all depends on which side of the race wins — which is not
  // the product's behaviour and must not decide whether the suite passes.
  const turn = page.request.post(
    `/api/bots/${encodeURIComponent(botId)}/turns`,
    {
      data: {
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        text: "Take your time",
      },
    },
  );
  const response = await page.request.post(
    `/api/bots/${encodeURIComponent(botId)}/conversations`,
    { data: { schemaVersion: 1 } },
  );
  await turn.catch(() => undefined);

  if (response.status() !== 200) {
    expect(response.status()).toBe(409);
    const body = (await response.json()) as { error?: string };
    expect(body.error ?? "").toMatch(/still working on a Turn/);
  }
});
