// ADR 0030 step 3, entirely through `SELF.fetch`.
//
// A Card is a thing a Bot put in the conversation and a person presses, so
// every step here is a request a client makes: a Turn draws the surface and
// keeps going, `GET /cards` and `GET /cards/:surfaceId` read it, and `POST`
// is one press whose meaning the kernel — never the Card — decides.
//
// The adversarial half is the point of the routing: a Card naming an approval
// the kernel never issued is refused, a name that is almost `approval/` is
// refused rather than becoming conversation input, and a press at a revision
// the surface has moved past is refused rather than applied to a card the
// person was not looking at.
import { describe, expect, it } from "vitest";
import {
  asUser,
  expectOkJson,
  freshUserId,
  postAsUser,
  provisionThroughGateway,
  readStoredRunWithEventsV1,
  toolCallTriggerPrompt,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

interface TurnView {
  runId: string;
  status: string;
  events: Array<{ type: string; payload?: { type?: string } }>;
}

interface CardView {
  surfaceId: string;
  revision: number;
  components: Array<{ id: string; component: string; text?: string }>;
  dataModel: Record<string, unknown>;
  deleted?: true;
  refusal?: string;
}

interface StoredRunProbe {
  runId: string;
  events: Array<{
    type: string;
    text?: string;
    request?: { messages?: unknown };
  }>;
}

const CREATE_DRAFT = {
  version: "v1.0",
  createSurface: {
    surfaceId: "draft",
    sendDataModel: true,
    components: [
      { id: "root", component: "Column", children: ["title", "send"] },
      { id: "title", component: "Text", text: "Draft email" },
      { id: "send", component: "Button", label: "Send", action: "send-draft" },
    ],
    dataModel: { subject: "Hello" },
  },
};

/** One Turn whose scripted calls are `send_to_user` payloads, in order. */
function turn(
  userId: string,
  botId: string,
  commandId: string,
  payloads: unknown[],
): Promise<Response> {
  return postAsUser(userId, `/api/bots/${botId}/turns`, {
    schemaVersion: 1,
    commandId,
    text: toolCallTriggerPrompt(
      ...payloads.map(
        (payload, index) =>
          [
            "send_to_user",
            {
              disposition:
                index === payloads.length - 1 ? "finish" : "continue",
              payload,
            },
          ] as [string, unknown],
      ),
    ),
  });
}

function cardTurn(
  userId: string,
  botId: string,
  commandId: string,
  messages: unknown[],
  surfaceId = "draft",
): Promise<Response> {
  return turn(userId, botId, commandId, [
    { type: "card", surfaceId, messages },
    { type: "text", text: "Done." },
  ]);
}

async function listCards(
  userId: string,
  botId: string,
): Promise<{ cards: CardView[]; truncated?: true }> {
  return (await expectOkJson(
    await asUser(userId, `/api/bots/${botId}/cards`),
  )) as { cards: CardView[]; truncated?: true };
}

function press(
  userId: string,
  botId: string,
  command: unknown,
): Promise<Response> {
  return postAsUser(userId, `/api/bots/${botId}/cards`, command);
}

function requestTexts(run: StoredRunProbe): string[] {
  return run.events
    .filter((event) => event.type === "model/request")
    .flatMap((event) =>
      ((event.request?.messages ?? []) as Array<{ content?: unknown }>).map(
        (message) =>
          typeof message.content === "string" ? message.content : "",
      ),
    );
}

describe("A2UI cards through the gateway", () => {
  it("draws a surface without ending the Turn, updates it in place, and reads it back", async () => {
    const userId = freshUserId("cards");
    const botId = "cards-bot";
    await provisionThroughGateway({ userId, botId });

    const drawn = (await expectOkJson(
      await cardTurn(userId, botId, "draw", [CREATE_DRAFT]),
    )) as TurnView;

    // Deliberately unlike a widget or an approval: the card is sent and the
    // Turn carries on to its own closing message.
    const transcript = (await expectOkJson(
      await asUser(userId, `/api/bots/${botId}/turns`),
    )) as { runs: TurnView[] };
    const rendered = transcript.runs.find((run) => run.runId === drawn.runId);
    expect(rendered?.status).toBe("completed");
    expect(
      rendered?.events
        .filter((event) => event.type === "send/to-user")
        .map((event) => event.payload?.type),
    ).toEqual(["card", "text"]);

    const listed = await listCards(userId, botId);
    expect(listed.cards).toHaveLength(1);
    expect(listed.cards[0]).toMatchObject({
      surfaceId: "draft",
      revision: 1,
      dataModel: { subject: "Hello" },
    });
    expect(listed.cards[0]!.components.map((part) => part.id)).toEqual([
      "root",
      "title",
      "send",
    ]);

    // A later send naming the same surface updates it: components upsert by
    // id keeping first-seen order, and the pointer write lands in the model.
    await expectOkJson(
      await cardTurn(userId, botId, "update", [
        {
          version: "v1.0",
          updateComponents: {
            surfaceId: "draft",
            components: [{ id: "title", component: "Text", text: "Re: hello" }],
          },
        },
        {
          version: "v1.0",
          updateDataModel: {
            surfaceId: "draft",
            path: "/subject",
            value: "Re: hello",
          },
        },
      ]),
    );

    const byId = (await expectOkJson(
      await asUser(userId, `/api/bots/${botId}/cards/draft`),
    )) as CardView;
    expect(byId.revision).toBeGreaterThan(1);
    expect(byId.dataModel).toEqual({ subject: "Re: hello" });
    expect(byId.components.map((part) => part.id)).toEqual([
      "root",
      "title",
      "send",
    ]);
    expect(
      byId.components.find((part) => part.id === "title")?.text,
    ).toBe("Re: hello");

    // A press at a revision the surface has moved past is refused, not
    // applied to a card the person was not looking at.
    const stale = await press(userId, botId, {
      schemaVersion: 1,
      surfaceId: "draft",
      revision: 1,
      event: { name: "send-draft" },
    });
    expect(stale.status).toBe(409);

    // The same press at the revision they were shown is conversation input.
    const routed = await press(userId, botId, {
      schemaVersion: 1,
      surfaceId: "draft",
      revision: byId.revision,
      event: { name: "send-draft", context: { confirmed: true } },
    });
    expect(routed.status).toBe(200);
    expect(await routed.json()).toMatchObject({
      routed: "input",
      card: { surfaceId: "draft", revision: byId.revision },
    });

    // And the Bot's next Turn is run on it as a press, never as a sentence
    // the person is made to have said.
    const next = (await expectOkJson(
      await turn(userId, botId, "after-press", [
        { type: "text", text: "Sent." },
      ]),
    )) as TurnView;
    const run = (await readStoredRunWithEventsV1<StoredRunProbe>(
      userId,
      botId,
      next.runId,
    ))!;
    const prompt = requestTexts(run).join("\n");
    expect(prompt).toContain(
      '[Card] The person used "send-draft" on the card "draft".',
    );
    expect(prompt).toContain("This is a press on a control, not something");
    expect(prompt).toContain('{"confirmed":true}');
  });

  it("refuses a card's approval the kernel never issued, and a name that is almost one", async () => {
    const userId = freshUserId("cards-approval");
    const botId = "cards-approval-bot";
    await provisionThroughGateway({ userId, botId });

    await expectOkJson(
      await cardTurn(userId, botId, "draw", [
        {
          version: "v1.0",
          createSurface: {
            surfaceId: "draft",
            components: [{ id: "root", component: "Text", text: "Approve?" }],
          },
        },
      ]),
    );
    const card = (await expectOkJson(
      await asUser(userId, `/api/bots/${botId}/cards/draft`),
    )) as CardView;

    // A Card cannot mint its own approval: the record is the authority.
    const invented = await press(userId, botId, {
      schemaVersion: 1,
      surfaceId: "draft",
      revision: card.revision,
      event: { name: "approval/never-issued", context: { decision: "approved" } },
    });
    expect(invented.status).toBe(404);

    // Almost `approval/` is refused rather than quietly becoming something
    // the Bot reads as conversation input.
    const nearMiss = await press(userId, botId, {
      schemaVersion: 1,
      surfaceId: "draft",
      revision: card.revision,
      event: { name: "approval/not a valid id!", context: { decision: "approved" } },
    });
    expect(nearMiss.status).toBe(400);

    // And a plugin name with no action behind it is refused the same way.
    const halfPlugin = await press(userId, botId, {
      schemaVersion: 1,
      surfaceId: "draft",
      revision: card.revision,
      event: { name: "plugin/notes" },
    });
    expect(halfPlugin.status).toBe(400);

    // A press at an approval name with no decision is refused too.
    const undecided = await press(userId, botId, {
      schemaVersion: 1,
      surfaceId: "draft",
      revision: card.revision,
      event: { name: "approval/ap-1" },
    });
    expect(undecided.status).toBe(400);

    // A Plugin handler this Bot does not have is told, not thrown: the card
    // is left exactly as it was and the press says why it changed nothing.
    const absentPlugin = await press(userId, botId, {
      schemaVersion: 1,
      surfaceId: "draft",
      revision: card.revision,
      event: { name: "plugin/notes/save" },
    });
    expect(absentPlugin.status).toBe(200);
    const receipt = (await absentPlugin.json()) as {
      routed: string;
      failure?: string;
      card: CardView;
    };
    expect(receipt.routed).toBe("plugin");
    expect(receipt.failure ?? "").not.toBe("");
    expect(receipt.card.revision).toBe(card.revision);

    // None of the refusals moved the surface or queued anything.
    const after = (await expectOkJson(
      await asUser(userId, `/api/bots/${botId}/cards/draft`),
    )) as CardView;
    expect(after.revision).toBe(card.revision);
  });

  it("tombstones a deleted surface, keeps it readable, and refuses presses on it", async () => {
    const userId = freshUserId("cards-delete");
    const botId = "cards-delete-bot";
    await provisionThroughGateway({ userId, botId });

    await expectOkJson(await cardTurn(userId, botId, "draw", [CREATE_DRAFT]));
    await expectOkJson(
      await cardTurn(userId, botId, "delete", [
        { version: "v1.0", deleteSurface: { surfaceId: "draft" } },
      ]),
    );

    // The send is still in the transcript, so the surface still answers.
    const tombstone = (await expectOkJson(
      await asUser(userId, `/api/bots/${botId}/cards/draft`),
    )) as CardView;
    expect(tombstone).toMatchObject({ deleted: true, components: [] });

    const pressed = await press(userId, botId, {
      schemaVersion: 1,
      surfaceId: "draft",
      revision: tombstone.revision,
      event: { name: "send-draft" },
    });
    expect(pressed.status).toBe(404);

    // An update onto a tombstone leaves a record that is deleted and says why
    // rather than one that is both gone and populated.
    await expectOkJson(
      await cardTurn(userId, botId, "update-tombstone", [
        {
          version: "v1.0",
          updateComponents: {
            surfaceId: "draft",
            components: [{ id: "title", component: "Text", text: "back?" }],
          },
        },
      ]),
    );
    const refused = (await expectOkJson(
      await asUser(userId, `/api/bots/${botId}/cards/draft`),
    )) as CardView;
    expect(refused.deleted).toBe(true);
    expect(refused.components).toEqual([]);
    expect(refused.refusal ?? "").toContain("deleted");

    // A surface this Bot never drew is not found.
    const missing = await asUser(userId, `/api/bots/${botId}/cards/never-drawn`);
    expect(missing.status).toBe(404);
  });

  it("makes room for a newer card when the Session is full, and says so on the one it dropped", async () => {
    const userId = freshUserId("cards-full");
    const botId = "cards-full-bot";
    await provisionThroughGateway({ userId, botId });

    // 32 surfaces is the Session's bound, so the 33rd has to cost one.
    for (let batch = 0; batch < 4; batch += 1) {
      const payloads = Array.from({ length: 8 }, (_unused, index) => {
        const surfaceId = `s${batch * 8 + index}`;
        return {
          type: "card",
          surfaceId,
          messages: [
            {
              version: "v1.0",
              createSurface: {
                surfaceId,
                components: [
                  { id: "root", component: "Text", text: surfaceId },
                ],
              },
            },
          ],
        };
      });
      await expectOkJson(
        await turn(userId, botId, `fill-${batch}`, [
          ...payloads,
          { type: "text", text: "Drawn." },
        ]),
      );
    }

    const full = await listCards(userId, botId);
    expect(full.cards.filter((card) => card.deleted === undefined)).toHaveLength(
      32,
    );

    await expectOkJson(
      await cardTurn(
        userId,
        botId,
        "one-more",
        [
          {
            version: "v1.0",
            createSurface: {
              surfaceId: "newest",
              components: [{ id: "root", component: "Text", text: "newest" }],
            },
          },
        ],
        "newest",
      ),
    );

    // The new card was drawn, and the oldest one says why it is gone rather
    // than vanishing with nothing anywhere explaining it.
    const newest = (await expectOkJson(
      await asUser(userId, `/api/bots/${botId}/cards/newest`),
    )) as CardView;
    expect(newest.revision).toBe(1);
    expect(newest.deleted).toBeUndefined();
    expect(newest.components).toHaveLength(1);

    const evicted = (await expectOkJson(
      await asUser(userId, `/api/bots/${botId}/cards/s0`),
    )) as CardView;
    expect(evicted.deleted).toBe(true);
    expect(evicted.refusal ?? "").toContain("room");

    const after = await listCards(userId, botId);
    expect(
      after.cards.filter((card) => card.deleted === undefined),
    ).toHaveLength(32);
  });
});
