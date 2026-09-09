// Messages.app on the registered Mac, end to end, through `SELF.fetch`.
//
// Register row 57g as a person actually meets it, and every step is a real
// request:
//
//   1. with the feature off, the seven tools are not in the catalog at all —
//      what a real `get_dynamic_tools` over the `frockbot` namespace answers is
//      the proof, because that is how the Bot finds out what it can do;
//   2. the User turns it on from the settings surface, and they appear;
//   3. `machine_messages_check_permissions` round-trips over the machine
//      routes, and what the Mac reports is what the gate then believes;
//   4. one read queues one `{kind:"messages"}` command, the stub agent answers
//      it, and `machine_command_check` reads the rows back;
//   5. `machine_messages_send` produces an approval card carrying the exact
//      text, and nothing reaches the Mac until somebody answers it.
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { machineRoutePathV1 } from "@frockbot/core/machine-protocol";
import type { MachineCommandV1 } from "@frockbot/core/machine-protocol";
import { MachineAgentDriverV1 } from "@frockbot/app/machine/testing";
import {
  frockbotToolCallPrompt,
  toolCallTriggerPrompt,
} from "../harness/miniflare.ts";
import { decodeDiscoveredCatalogV1 } from "../dynamic-tools.ts";
import {
  asUser,
  expectOkJson,
  freshUserId,
  ORIGIN,
  postAsUser,
  provisionThroughGateway,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

interface TurnView {
  runId: string;
  status: string;
  events: Array<{
    type: string;
    content?: string;
    isError?: boolean;
    payload?: { type?: string; approvalId?: string; action?: string };
  }>;
}

const PERMISSIONS = {
  schemaVersion: 1,
  fullDiskAccess: true,
  automation: true,
  checkedAt: "2026-09-01T00:00:00.000Z",
} as const;

function toolResults(turn: TurnView): Array<{
  content?: string;
  isError?: boolean;
}> {
  return turn.events.filter((event) => event.type === "tool/result");
}

async function turn(
  userId: string,
  botId: string,
  commandId: string,
  tool: string,
  input: Record<string, unknown>,
): Promise<TurnView> {
  return (await expectOkJson(
    await postAsUser(userId, `/api/bots/${botId}/turns`, {
      schemaVersion: 1,
      commandId,
      text: frockbotToolCallPrompt(tool, input),
    }),
  )) as TurnView;
}

/**
 * The machine tools the Bot can reach on one Turn, read the way the model
 * reads them: a real `get_dynamic_tools` search. First-party tools are
 * discovered on demand rather than listed by name in the request, so what
 * discovery answers — not the offered schemas — is what the Bot can do.
 */
async function discoverableMachineTools(
  userId: string,
  botId: string,
  commandId: string,
): Promise<string[]> {
  const discovery = (await expectOkJson(
    await postAsUser(userId, `/api/bots/${botId}/turns`, {
      schemaVersion: 1,
      commandId,
      text: toolCallTriggerPrompt([
        "get_dynamic_tools",
        { pattern: "^machine_" },
      ]),
    }),
  )) as TurnView;
  const result = toolResults(discovery)[0];
  expect(result?.isError).toBe(false);
  return decodeDiscoveredCatalogV1(result!.content!).namespaces.flatMap(
    (namespace) => namespace.tools.map((tool) => tool.tool),
  );
}

/** The User turns the feature on, through the settings routes they would use. */
async function enableMessages(userId: string, botId: string): Promise<void> {
  const revision = async (): Promise<number> =>
    (
      (await expectOkJson(await asUser(userId, "/api/settings"))) as {
        revision: number;
      }
    ).revision;
  await expectOkJson(
    await postAsUser(userId, "/api/settings", {
      schemaVersion: 1,
      type: "user/install-package",
      commandId: `install-messages-${botId}`,
      expectedRevision: await revision(),
      packageId: "machine-messages",
      version: "0.0.1",
    }),
  );
  await expectOkJson(
    await postAsUser(userId, "/api/settings", {
      schemaVersion: 1,
      type: "user/set-package-settings",
      commandId: `enable-messages-${botId}`,
      expectedRevision: await revision(),
      packageId: "machine-messages",
      values: { "messages-enabled": true },
    }),
  );
}

describe("Messages.app on a registered Mac", () => {
  it("is absent until the user turns it on, then round-trips a read and asks before it sends", async () => {
    const userId = freshUserId("machine-messages");
    const botId = "machine-messages-bot";
    await provisionThroughGateway({ userId, botId });

    const offer = (await expectOkJson(
      await postAsUser(userId, machineRoutePathV1("pair"), {
        label: "Tims-M5-MacBook-Pro.local",
      }),
    )) as { code: string; machineId: string };

    // The Mac's agent reports `messages` — it is a Mac, and this build has the
    // handlers. What it answers is scripted; the wire is real.
    const device = new MachineAgentDriverV1({
      origin: ORIGIN,
      fetch: (input, init) => SELF.fetch(input, init),
      label: "Tims-M5-MacBook-Pro.local",
      platform: "macos",
      agentVersion: "0.4.1",
      capabilities: ["exec", "files", "messages"],
      handle: async (command: MachineCommandV1) => {
        const call =
          command.op.kind === "messages" ? command.op.call : undefined;
        const stdout =
          call?.kind === "check-permissions"
            ? JSON.stringify({
                kind: "permissions",
                permissions: PERMISSIONS,
              })
            : JSON.stringify({
                kind: "chats",
                chats: [
                  {
                    chatId: "iMessage;-;+61400000000",
                    name: "Mum",
                    lastMessageAt: "2026-08-31T22:00:00.000Z",
                  },
                ],
              });
        return {
          kind: "result",
          result: {
            finishedAt: new Date().toISOString(),
            outcome: "ok",
            truncated: false,
            stdout,
          },
        };
      },
    });
    await device.enroll(offer.code);

    // 1. Off by default. The Bot cannot discover the tools, so it cannot be
    //    talked into trying one — which is what a feature gate is for.
    const before = await discoverableMachineTools(
      userId,
      botId,
      "messages-before",
    );
    expect(before).toContain("machine_list");
    expect(
      before.filter((name) => name.startsWith("machine_messages_")),
    ).toEqual([]);

    // 2. The User turns it on.
    await enableMessages(userId, botId);

    // 3. The permission check is the only Messages tool that runs before the
    //    Mac has reported anything, and it is how the Mac reports.
    const checked = await turn(
      userId,
      botId,
      "messages-check",
      "machine_messages_check_permissions",
      { machineId: offer.machineId },
    );
    const after = await discoverableMachineTools(
      userId,
      botId,
      "messages-after",
    );
    for (const name of [
      "machine_messages_check_permissions",
      "machine_messages_find_chats",
      "machine_messages_chat_items",
      "machine_messages_search",
      "machine_messages_activity",
      "machine_messages_fetch_attachment",
      "machine_messages_send",
    ]) {
      expect(after).toContain(name);
    }
    expect(toolResults(checked)[0]?.isError).toBe(false);
    const answeredCheck = await device.runOnce();
    expect(answeredCheck.reported).toHaveLength(1);

    // 4. One read, one command, and the rows come back the way every other
    //    machine result does: read on demand rather than pushed.
    const read = await turn(
      userId,
      botId,
      "messages-read",
      "machine_messages_find_chats",
      { machineId: offer.machineId, query: "mum", limit: 5 },
    );
    // A read raises no card, and does not end the Turn.
    expect(
      read.events.some(
        (event) =>
          event.type === "send/to-user" && event.payload?.type === "approval",
      ),
    ).toBe(false);
    const answeredRead = await device.runOnce();
    expect(answeredRead.delivered).toHaveLength(1);
    const commandId = answeredRead.delivered[0]!.commandId;
    expect(answeredRead.delivered[0]!.op).toMatchObject({
      kind: "messages",
      call: { kind: "find-chats", query: "mum", limit: 5 },
    });

    const readBack = await turn(
      userId,
      botId,
      "messages-readback",
      "machine_command_check",
      { commandId },
    );
    const rows = toolResults(readBack)[0];
    expect(rows?.isError).toBe(false);
    expect(rows?.content).toContain("outcome: ok");
    expect(rows?.content).toContain("Mum");

    // 5. A send asks first, with the exact text on the card, and reaches the
    //    Mac only if somebody says yes.
    const send = await turn(
      userId,
      botId,
      "messages-send",
      "machine_messages_send",
      {
        machineId: offer.machineId,
        to: "+61400000000",
        text: "running ten minutes late",
      },
    );
    const card = send.events.find(
      (event) =>
        event.type === "send/to-user" && event.payload?.type === "approval",
    );
    expect(card?.payload?.action).toContain("running ten minutes late");
    expect(card?.payload?.action).toContain("+61400000000");
    expect(await device.poll()).toEqual([]);

    // …and once they do, the same queue carries it.
    const approvalId = card!.payload!.approvalId!;
    expect(
      (
        await postAsUser(userId, `/api/bots/${botId}/approvals/${approvalId}`, {
          schemaVersion: 1,
          decision: "approved",
        })
      ).status,
    ).toBe(200);
    const delivered = await device.poll();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.op).toEqual({
      kind: "messages",
      call: {
        kind: "send",
        to: "+61400000000",
        text: "running ten minutes late",
      },
    });
  });
});
