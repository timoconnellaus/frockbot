// Incident: the e2e shards died, every run, on "a new conversation clears the
// transcript and the Bot keeps working". The harness log named the sequence.
//
//   ✘ Uncaught Error: This Bot is still working on a Turn. …
//     at packages/kernel-do/src/authority.ts:1049
//   ✘ Uncaught TypeError: Can't read from request stream after response has
//     been sent.
//   ✘ kj::getCaughtExceptionAsKj() … disconnected: Broken pipe
//   FrockBot wrangler dev exited unexpectedly (code 1)
//
// Two faults, one request. The refusal was a domain "not now" thrown out of a
// Durable Object's entry frame, which workerd logs as uncaught; and
// `POST /conversations` is the one send whose body no route reads, so the
// wrapper that was meant to disturb it cancelled the stream instead of reading
// it, which leaves the writing end holding bytes it never delivered. In
// production the pair is a 500 where a 409 belonged, and an isolate that may
// not survive to answer the next request.
//
// So both claims are here, and both are claims about the deployed path:
// `SELF.fetch` enters `src/index.ts`, the gateway loads the real artifact, and
// the Bot Durable Object answers.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  asUser,
  expectJson,
  expectOkJson,
  freshUserId,
  postAsUser,
  provisionThroughGateway,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

/** `BotDurableAuthority`'s own key for the Turn it has admitted. */
const ACTIVE_RUN_KEY = "active-run";

interface ConversationList {
  schemaVersion: number;
  conversations: Array<{ conversationId: string; ordinal: number }>;
}

function botStub(userId: string, botId: string) {
  return env.BOT_STATES.get(env.BOT_STATES.idFromName(`${userId}:${botId}`));
}

/**
 * Leave the object holding an admitted Turn, without racing a real one.
 *
 * The e2e provokes this by starting a Turn and asking for a new conversation
 * without waiting — which is honest about the product but decides nothing when
 * the Turn wins the race. What is under test is the boundary's behaviour when
 * the refusal happens, so the refusal is made certain.
 */
async function holdAnAdmittedTurn(
  userId: string,
  botId: string,
): Promise<void> {
  await runInDurableObject(botStub(userId, botId), async (_instance, state) => {
    await state.storage.put(ACTIVE_RUN_KEY, `held-${crypto.randomUUID()}`);
  });
}

describe("a refused new conversation through the gateway", () => {
  it("answers 409 with the reason, and the Worker still serves the next request", async () => {
    const userId = freshUserId("busy-conversation");
    const botId = "busy-conversation-bot";
    await provisionThroughGateway({ userId, botId });

    // One Turn, so the Bot has a conversation to be asked to put down.
    expect(
      (
        await postAsUser(userId, `/api/bots/${botId}/turns`, {
          schemaVersion: 1,
          commandId: crypto.randomUUID(),
          text: "hello",
        })
      ).status,
    ).toBe(200);

    await holdAnAdmittedTurn(userId, botId);

    const refused = await postAsUser(
      userId,
      `/api/bots/${botId}/conversations`,
      {
        schemaVersion: 1,
      },
    );

    // A "not now" the composer already understands, with the sentence it
    // shows. Before the fix this was the same 409 — reached by throwing an
    // exception across two isolate boundaries to get there.
    expect(refused.status).toBe(409);
    expect(await expectJson(refused)).toMatchObject({
      error: expect.stringContaining("still working on a Turn"),
    });

    // The point of the whole suite: nothing was thrown out of a `fetch`, so
    // the isolate is still there. When the refusal escaped, this is where the
    // dev stack had already exited.
    expect((await asUser(userId, "/")).status).toBe(200);

    // And the conversation was not half-ended: the Bot is still on its first.
    const listed = (await expectOkJson(
      await asUser(userId, `/api/bots/${botId}/conversations`),
    )) as ConversationList;
    expect(listed.conversations.map((entry) => entry.ordinal)).toEqual([1]);
  });

  // The body half. `POST /conversations` carries `{"schemaVersion":1}` and no
  // route reads it, so it is exactly the shape that broke: the gateway pumps
  // the bytes into the loaded application's isolate, and that isolate answered
  // without ever retiring the pipe.
  //
  // Miniflare's loader does not model that pipe, so this is coverage of the
  // route rather than a reproduction — the read-versus-cancel distinction that
  // actually fixed it is pinned in `src/request-body.test.ts`, and the crash
  // itself only shows against the real dev stack in
  // `e2e/new-conversation.e2e.ts`.
  it("accepts a body no route reads, twice, without losing the isolate", async () => {
    const userId = freshUserId("unread-body");
    const botId = "unread-body-bot";
    await provisionThroughGateway({ userId, botId });

    const first = (await expectOkJson(
      await postAsUser(userId, `/api/bots/${botId}/conversations`, {
        schemaVersion: 1,
      }),
    )) as ConversationList;
    expect(first.conversations.map((entry) => entry.ordinal)).toEqual([2, 1]);

    // A second one, because the first crash took the process down and the
    // suite would otherwise be asserting against a Worker that had already
    // gone. A larger body too: the bytes have to travel the whole pipe.
    const second = (await expectOkJson(
      await postAsUser(userId, `/api/bots/${botId}/conversations`, {
        schemaVersion: 1,
        ignored: "b".repeat(20_000),
      }),
    )) as ConversationList;
    expect(second.conversations.map((entry) => entry.ordinal)).toEqual([
      3, 2, 1,
    ]);

    expect((await asUser(userId, "/")).status).toBe(200);
  });
});
