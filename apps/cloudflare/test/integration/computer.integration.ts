// The Computer half of seam S7: the Bot Durable Object → the shared Computer
// host (ADR 0004), driven from the gateway's own door.
//
// `computer-host-client.workerd.ts` proves the client against the fake from
// inside a probe Durable Object. What it cannot prove is that the production
// path *reaches* that client: the `SPRITES_TOKEN` gate, the `COMPUTER_HOST`
// binding the Bot Durable Object passes to the runtime, the Computer Package's
// tool, and the Agent loop that admits and journals the call. Every one of
// those is between `SELF.fetch` and the envelope the host records, so this is
// the only layer that can observe them together.
//
// Nothing here calls a tool directly. The stubbed Ollama Cloud endpoint answers
// a `tool_calls` stream when the Turn's user message carries
// {@link TOOL_CALL_TRIGGER}, exactly as `bot-self-management.integration.ts`
// drives its tools, so the model asks for `computer_exec` and the loop does the
// rest.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type {
  FakeComputerHostCall,
  FakeExecScript,
} from "../computer-host-fake.ts";
import { TOOL_CALL_TRIGGER } from "../harness/miniflare.ts";
import {
  asUser,
  expectOkJson,
  freshUserId,
  postAsUser,
  provisionThroughGateway,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

/** The fake host's control plane. A service binding ignores the host name. */
const HOST = "http://computer-host.internal";

/**
 * `plugin-fly-sprite` wraps the Bot's command in a guard and reads the inner
 * command's exit code back off this marker, so a scripted answer that omits it
 * is a command with no exit code — which the Computer Package reports as a
 * failure. Kept as a literal rather than imported: the fake is standing in for
 * a real Computer, and a real Computer would print it because the script told
 * it to.
 */
const EXEC_EXIT_MARKER = "__FROCKBOT_EXIT__";

interface ClientTurn {
  runId: string;
  status?: string;
  events: Array<
    | { type: "tool/call"; call: { id: string; name: string } }
    | { type: "tool/result"; callId: string; content: string; isError: boolean }
    | { type: "run/events-truncated"; omittedInteractions: number }
  >;
}

/**
 * Teaches the fake how to answer one exec.
 *
 * Nothing here resets the fake. Its state is one Node-side object shared by
 * every file in the run, and each rule is matched by a marker no other test
 * uses, so adding a rule can never take one away from somebody else.
 */
async function script(rule: FakeExecScript): Promise<void> {
  const response = await env.COMPUTER_HOST.fetch(
    new Request(`${HOST}/__fake/exec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rule),
    }),
  );
  expect(response.status).toBe(200);
}

/** The exec envelopes the host recorded for one User, in order. */
async function execsFor(userId: string): Promise<FakeComputerHostCall[]> {
  const response = await env.COMPUTER_HOST.fetch(
    new Request(`${HOST}/__fake/calls`),
  );
  const body = (await response.json()) as { calls: FakeComputerHostCall[] };
  return body.calls.filter(
    (call) => call.kind === "exec" && call.userId === userId,
  );
}

/** Runs one chat Turn whose model answers with `computer_exec(command)`. */
async function turnRunning(
  userId: string,
  botId: string,
  commandId: string,
  command: string,
): Promise<ClientTurn> {
  return (await expectOkJson(
    await postAsUser(userId, `/api/bots/${botId}/turns`, {
      schemaVersion: 1,
      commandId,
      text: `${TOOL_CALL_TRIGGER}computer_exec:${JSON.stringify({ command })}`,
    }),
  )) as ClientTurn;
}

/** The `computer_exec` result of a Turn, whether it succeeded or failed. */
function execResult(turn: ClientTurn): { content: string; isError: boolean } {
  const call = turn.events.find(
    (event) =>
      event.type === "tool/call" && event.call.name === "computer_exec",
  );
  expect(call, "the Turn made no computer_exec call").toBeDefined();
  const callId = (call as { call: { id: string } }).call.id;
  const result = turn.events.find(
    (event) => event.type === "tool/result" && event.callId === callId,
  ) as { content: string; isError: boolean } | undefined;
  expect(result, "the computer_exec call produced no result").toBeDefined();
  return result!;
}

/** The same Turn as the client reads it back after a reload. */
async function storedTurn(
  userId: string,
  botId: string,
  runId: string,
): Promise<ClientTurn> {
  const list = (await expectOkJson(
    await asUser(userId, `/api/bots/${botId}/turns`),
  )) as { runs: ClientTurn[] };
  const run = list.runs.find((candidate) => candidate.runId === runId);
  expect(run, `no stored run ${runId}`).toBeDefined();
  return run!;
}

describe("a Turn that uses the Computer through the shared host", () => {
  it("sends the v1 envelope the host decodes and carries its stdout back", async () => {
    const userId = freshUserId("computer-exec");
    const botId = "computer-bot";
    // A marker no other rule matches, so this answer belongs to this exec and
    // not to the Workspace sync's own commands.
    const marker = `frockbot-exec-${crypto.randomUUID()}`;
    await script({
      match: marker,
      stdout: `hello from the Computer\n${EXEC_EXIT_MARKER}0\n`,
    });
    await provisionThroughGateway({ userId, botId });

    const turn = await turnRunning(
      userId,
      botId,
      "computer-exec-1",
      `echo ${marker}`,
    );

    const recorded = await execsFor(userId);
    const exec = recorded.find((call) => call.script?.includes(marker));
    expect(exec, "the host recorded no exec for this Turn").toBeDefined();
    // Whose Computer, which tenant, and — the point of ADR 0004 — a reference
    // rather than a credential. `SPRITES_TOKEN` never leaves the host Worker.
    expect(exec).toMatchObject({
      userId,
      botId,
      credentialRef: `sprites:user:${userId}`,
    });
    expect(JSON.stringify(exec)).not.toContain("SPRITES_TOKEN");

    const result = execResult(turn);
    expect(result.isError, result.content).toBe(false);
    expect(result.content).toContain("hello from the Computer");

    // And the Bot's own conversational history says the same, so the answer
    // survives the request that produced it.
    const stored = await storedTurn(userId, botId, "computer-exec-1");
    expect(JSON.stringify(stored.events)).toContain("hello from the Computer");
  });

  it("turns a host that never answers into a durable, visible failure", async () => {
    const userId = freshUserId("computer-hang");
    const botId = "hanging-bot";
    const marker = `frockbot-hang-${crypto.randomUUID()}`;
    // Far longer than any deadline in the run. The fake caps a hang at its own
    // `maximumHangMs` and then answers the `timeout` problem a host that never
    // answered produces, which is what the Durable Object has to survive.
    await script({ match: marker, hangMs: 600_000 });
    await provisionThroughGateway({ userId, botId });

    const turn = await turnRunning(
      userId,
      botId,
      "computer-hang-1",
      `sleep 600 # ${marker}`,
    );

    // The Turn ended. It did not hang, and it did not take the Worker down.
    const result = execResult(turn);
    expect(result.isError).toBe(true);
    // The reason is the host's own `timeout` problem, carried across the seam
    // and named to the Bot — not a bare transport error and not a hang.
    expect(result.content).toContain("never answered");

    // The failure is durable: the client reads the same reason back, attached
    // to the same call, after the request that produced it is gone.
    const stored = await storedTurn(userId, botId, "computer-hang-1");
    expect(stored.status).not.toBe("running");
    const storedResult = execResult(stored);
    expect(storedResult.isError).toBe(true);
    expect(storedResult.content).toBe(result.content);
  });
});
