// Republishing a Plugin whose page changed, end to end through a real Bot and
// the real User Composition, in workerd.
//
// A Plugin's page is its own artifact on the Composition member, so a page
// edit — or a page rebuilt with a newer injected bridge — leaves the module's
// hash as it was. The build stand-in (`applet-build-fake.ts`) compiles every
// source to the same module bytes, which is exactly that case: only the page
// differs between the two publishes here. Approving the second publish must
// still put the new page in a new generation, and approving a publish that
// changed nothing must not make one.
import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { pluginPageKeyV1 } from "@frockbot/core/contracts";
import type { CompositionMemberV1 } from "@frockbot/core/durable";
import { frockbotToolCallPrompt } from "./harness/miniflare.ts";
import { provisionBot } from "./provision-bot.ts";

interface Identity {
  userId: string;
  botId: string;
}

interface BotRpc {
  run(command: unknown): Promise<{
    events: Array<{ type: string; content?: string; isError?: boolean }>;
  }>;
  listApprovals(input: unknown): Promise<{
    approvals: Array<{ approvalId: string; decision: string }>;
  }>;
  decideApproval(input: unknown): Promise<{ status: string }>;
}

function bot(identity: Identity): BotRpc {
  // SAFETY: the generated stub type for the Bot RPCs is too deep for the
  // compiler to instantiate here; this names only the methods this test calls.
  return env.BOT_STATES.getByName(
    `${identity.userId}:${identity.botId}`,
  ) as unknown as BotRpc;
}

async function enablePluginAuthoring(userId: string): Promise<void> {
  const user = env.USER_CONFIGURATIONS.getByName(userId) as unknown as {
    setFeatures(input: unknown): Promise<unknown>;
  };
  await user.setFeatures({
    schemaVersion: 1,
    userId,
    command: {
      schemaVersion: 1,
      type: "user/set-features",
      pluginAuthoring: true,
    },
    updatedBy: "workerd-admin",
  });
}

let turns = 0;

async function tool(
  identity: Identity,
  name: string,
  input: unknown,
): Promise<string> {
  turns += 1;
  const turn = await bot(identity).run({
    schemaVersion: 1,
    ...identity,
    command: {
      runId: `republish-${turns}-${identity.botId}`,
      sessionId: `${identity.userId}:${identity.botId}`,
      acceptedAt: new Date().toISOString(),
      text: frockbotToolCallPrompt(name, input),
    },
  });
  const result = turn.events.find((event) => event.type === "tool/result");
  expect(result, `${name} recorded no tool result`).toBeDefined();
  expect(result?.isError, `${name} answered: ${result?.content}`).not.toBe(
    true,
  );
  return result?.content ?? "";
}

/** Publishes, then approves the one card the publish left pending. */
async function publishAndApprove(identity: Identity): Promise<void> {
  const said = await tool(identity, "plugin_publish", {
    pluginId: "tuner",
    purpose: "Tune a guitar.",
  });
  expect(said).toContain("asked the User to approve it");
  const { approvals } = await bot(identity).listApprovals({
    schemaVersion: 1,
    ...identity,
  });
  const pending = approvals.filter((card) => card.decision === "pending");
  expect(pending).toHaveLength(1);
  const decided = await bot(identity).decideApproval({
    schemaVersion: 1,
    ...identity,
    approvalId: pending[0]!.approvalId,
    command: { schemaVersion: 1, decision: "approved" },
  });
  expect(decided.status).toBe("recorded");
}

async function heldTuner(userId: string): Promise<{
  generationId: string;
  member: CompositionMemberV1;
}> {
  const user = env.USER_CONFIGURATIONS.getByName(userId) as unknown as {
    readComposition(input: unknown): Promise<{
      current: { generationId: string; members: CompositionMemberV1[] };
    }>;
  };
  const { current } = await user.readComposition({ schemaVersion: 1, userId });
  const member = current.members.find(
    (candidate) => candidate.packageId === "tuner",
  );
  if (!member) throw new Error("the Composition does not hold the tuner");
  return { generationId: current.generationId, member };
}

async function servedPage(member: CompositionMemberV1): Promise<string> {
  const page = member.pages?.[0];
  if (!page) throw new Error("the tuner has no page");
  const object = await env.APPLICATION_ARTIFACTS.get(
    pluginPageKeyV1(page.contentHash),
  );
  if (!object) throw new Error("the page's artifact is not stored");
  return await object.text();
}

const DESCRIPTOR = JSON.stringify(
  {
    id: "tuner",
    displayName: "Tuner",
    version: "1.0.0",
    contractVersion: 7,
    tools: [],
    hooks: [],
    grants: [],
    views: [
      {
        slot: "conversation.panel",
        surfaceId: "tuner",
        label: "Tuner",
        page: "tuner.html",
      },
    ],
    contextKeys: ["user", "bot", "session"],
  },
  null,
  2,
);

const pageSaying = (words: string) =>
  `<!doctype html><html><body><p id="note">${words}</p></body></html>\n`;

describe("republishing a Plugin whose only change is its page", () => {
  test("an approved republish puts the new page in a new generation, and an unchanged one makes none", async () => {
    const id = crypto.randomUUID().slice(0, 8);
    const identity = { userId: `republish-${id}`, botId: `bot-${id}` };
    await provisionBot(identity);
    await enablePluginAuthoring(identity.userId);

    await tool(identity, "plugin_create", { displayName: "Tuner" });
    await tool(identity, "plugin_write_file", {
      pluginId: "tuner",
      path: "plugin.json",
      text: DESCRIPTOR,
    });
    await tool(identity, "plugin_write_file", {
      pluginId: "tuner",
      path: "tuner.html",
      text: pageSaying("Stop jams"),
    });

    await publishAndApprove(identity);
    const first = await heldTuner(identity.userId);
    expect(await servedPage(first.member)).toContain("Stop jams");

    // Only the page changes: the module the build returns is byte-identical.
    await tool(identity, "plugin_write_file", {
      pluginId: "tuner",
      path: "tuner.html",
      text: pageSaying("Stop works"),
    });
    await publishAndApprove(identity);
    const second = await heldTuner(identity.userId);
    expect(second.member.artifact.contentHash).toBe(
      first.member.artifact.contentHash,
    );
    expect(second.member.pages?.[0]?.contentHash).not.toBe(
      first.member.pages?.[0]?.contentHash,
    );
    expect(second.generationId).not.toBe(first.generationId);
    expect(await servedPage(second.member)).toContain("Stop works");

    // The same Plugin again, from another Turn: nothing but who published it
    // differs, so the approval applies without a second generation.
    await publishAndApprove(identity);
    const third = await heldTuner(identity.userId);
    expect(third.generationId).toBe(second.generationId);
    expect(third.member.provenance).toEqual(second.member.provenance);

    console.log(
      JSON.stringify(
        {
          first: {
            generationId: first.generationId,
            module: first.member.artifact.contentHash,
            page: first.member.pages?.[0]?.contentHash,
            turn: first.member.provenance,
          },
          second: {
            generationId: second.generationId,
            module: second.member.artifact.contentHash,
            page: second.member.pages?.[0]?.contentHash,
          },
          third: {
            generationId: third.generationId,
            module: third.member.artifact.contentHash,
            page: third.member.pages?.[0]?.contentHash,
          },
        },
        null,
        2,
      ),
    );
  });
});
