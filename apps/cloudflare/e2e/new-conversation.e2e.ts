// Journey 6 step 2: "start a new conversation with the same Bot".
//
// Until ADR 0027 there was no way to do it. A Bot had one Session for its
// whole life, so the transcript only ever grew and the memory-recall proof the
// journey exists to make was confounded — the fact the Bot "remembered" was
// still sitting in message history.
//
// This is the seam from the composer's action through the application Worker
// to the Bot Durable Object's durable conversation boundary: the transcript
// shows the new conversation, the Turns of the old one are still on disk, and
// the Bot keeps answering.
import { test, expect, provisionThroughUi, sendMessage } from "./fixtures.ts";
import { E2E_OLLAMA_GOOD_API_KEY } from "./harness.ts";

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

  const first = "The first conversation";
  await sendMessage(page, first);
  const thread = page.locator("main");
  await expect(thread.getByText(first)).toBeVisible();

  await page.getByRole("button", { name: "New conversation" }).click();

  // The transcript is the conversation, so it shows the new one.
  await expect(thread.getByText(first)).toHaveCount(0);

  // And the Bot is not wedged: the next Turn is admitted and answered in the
  // new Session.
  const second = "The second conversation";
  await sendMessage(page, second);
  await expect(thread.getByText(second)).toBeVisible();
  await expect(thread.getByText(first)).toHaveCount(0);

  // The conversation just ended is still durable, Turn for Turn: it is listed,
  // and its runs are readable by naming it.
  const listed = await page.evaluate(async () => {
    const url = new URL(window.location.href);
    const botId = url.searchParams.get("bot");
    const response = await fetch(
      `/api/bots/${encodeURIComponent(botId!)}/conversations`,
      { credentials: "include" },
    );
    return (await response.json()) as {
      conversations: Array<{ conversationId: string; ordinal: number }>;
    };
  });
  expect(listed.conversations.length).toBe(2);
  expect(listed.conversations[0]!.ordinal).toBe(2);
  expect(listed.conversations[1]!.ordinal).toBe(1);

  const earlier = await page.evaluate(async (conversationId: string) => {
    const url = new URL(window.location.href);
    const botId = url.searchParams.get("bot");
    const response = await fetch(
      `/api/bots/${encodeURIComponent(botId!)}/turns?conversationId=${encodeURIComponent(
        conversationId,
      )}`,
      { credentials: "include" },
    );
    return (await response.json()) as { runs: Array<{ input: string }> };
  }, listed.conversations[1]!.conversationId);
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

  // The log a running Turn is appending to is not something a click may pull
  // out from under it, so the action refuses with its reason rather than
  // half-ending a conversation.
  const refusal = await page.evaluate(async () => {
    const url = new URL(window.location.href);
    const botId = url.searchParams.get("bot");
    const path = `/api/bots/${encodeURIComponent(botId!)}/conversations`;
    // Start a Turn and, without waiting for it, ask for a new conversation.
    const turn = fetch(`/api/bots/${encodeURIComponent(botId!)}/turns`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        text: "Take your time",
      }),
    });
    const response = await fetch(path, {
      method: "POST",
      credentials: "include",
      body: JSON.stringify({ schemaVersion: 1 }),
    });
    const body = (await response.json()) as { error?: string };
    await turn.catch(() => undefined);
    return { status: response.status, body };
  });

  if (refusal.status !== 200) {
    expect(refusal.status).toBe(409);
    expect(refusal.body.error ?? "").toMatch(/still working on a Turn/);
  }
});
