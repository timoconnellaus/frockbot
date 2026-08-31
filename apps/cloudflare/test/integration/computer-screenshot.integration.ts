// Parity row 25, end to end: the model asks for a screenshot and the Bot files
// one.
//
// `computer-screenshot.workerd.ts` proves the two host operations on the real
// wire. What only this layer can show is the rest of the path: the Agent loop
// admitting the call, the Computer Package writing the bytes *through* the
// Workspace so the Bot is recorded as their writer, the JSON the model reads
// back, and the attachment reference surviving in durable state after the
// request that produced it is gone.
//
// The bytes reach object storage through the durable-root sync, which is
// `computer-sync.workerd.ts`'s subject; what is asserted here about the
// Workspace read route is that it decodes the recorded path and answers a
// declared outcome rather than a routing failure.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { computerBotKey } from "@frockbot/plugin-fly-sprite";
import type { FakeExecScript } from "../computer-host-fake.ts";
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

const HOST = "http://computer-host.internal";
const BOT_ID = "screenshot-bot";
const BOT_KEY = computerBotKey(BOT_ID);
const SCREENSHOT_PATH = `/home/box/.frockbot/bots/${BOT_KEY}/screenshot.png`;
const SCREENSHOTS_ROOT =
  "/home/box/agent-data/user-packages/computer/screenshots";

interface ClientTurn {
  runId: string;
  events: Array<{
    type: string;
    call?: { id: string; name: string };
    callId?: string;
    content?: string;
    isError?: boolean;
    attachments?: Array<{ contentHash: string; path: string }>;
  }>;
}

/** A 4x3 PNG: a real signature and a real IHDR. */
function png(): { bytes: Uint8Array; base64: string } {
  const bytes = new Uint8Array(32);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, 4);
  view.setUint32(20, 3);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return { bytes, base64: btoa(binary) };
}

async function post(path: string, body: unknown): Promise<void> {
  const response = await env.COMPUTER_HOST.fetch(
    new Request(`${HOST}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  expect(response.status).toBe(200);
}

async function script(rule: FakeExecScript): Promise<void> {
  await post("/__fake/exec", rule);
}

describe("a Turn whose model asks for a screenshot", () => {
  it("files the capture in the screenshots root and answers with its path and hash", async () => {
    const userId = freshUserId("computer-screenshot");
    const image = png();

    // The Computer this Turn will drive: `scrot` reports what it wrote, the
    // Workspace write reports that it landed, and the prune's listing is
    // empty because this is the first capture.
    await script({ match: SCREENSHOTS_ROOT, stdout: "" });
    await script({ match: "echo __WRITTEN__", stdout: "__WRITTEN__\n" });
    await script({ match: SCREENSHOT_PATH, stdout: "32\n" });
    await post("/__fake/file-bytes", {
      userId,
      path: SCREENSHOT_PATH,
      bytesBase64: image.base64,
    });
    await provisionThroughGateway({ userId, botId: BOT_ID });

    const turn = (await expectOkJson(
      await postAsUser(userId, `/api/bots/${BOT_ID}/turns`, {
        schemaVersion: 1,
        commandId: "computer-screenshot-1",
        text: `${TOOL_CALL_TRIGGER}computer_screenshot:{}`,
      }),
    )) as ClientTurn;

    const call = turn.events.find(
      (event) =>
        event.type === "tool/call" &&
        event.call?.name === "computer_screenshot",
    );
    expect(call, "the Turn made no computer_screenshot call").toBeDefined();
    const result = turn.events.find(
      (event) =>
        event.type === "tool/result" && event.callId === call!.call!.id,
    );
    expect(result?.isError, result?.content).toBe(false);

    const answer = JSON.parse(result!.content!) as Record<string, unknown>;
    expect(answer).toMatchObject({
      rootId: "screenshots",
      bytes: 32,
      width: 4,
      height: 3,
      display: ":100",
    });
    expect(answer.path).toBe(`${BOT_KEY}/computer-screenshot-1-1.png`);
    expect(String(answer.contentHash)).toMatch(/^[0-9a-f]{64}$/);

    // The image reaches the client as a reference, never as bytes: the thread
    // is durable state, and a base64 screenshot in it would be a record that
    // grows past what one Durable Object value can hold.
    expect(result!.attachments).toHaveLength(1);
    expect(result!.attachments![0]!.contentHash).toBe(answer.contentHash);
    expect(JSON.stringify(turn.events)).not.toContain(image.base64);

    // And it is durable: the same reference reads back after the request that
    // produced it is gone.
    const list = (await expectOkJson(
      await asUser(userId, `/api/bots/${BOT_ID}/turns`),
    )) as { runs: ClientTurn[] };
    const stored = list.runs.find(
      (run) => run.runId === "computer-screenshot-1",
    );
    const storedResult = stored?.events.find(
      (event) => event.type === "tool/result",
    );
    expect(storedResult?.attachments?.[0]?.contentHash).toBe(
      answer.contentHash,
    );

    // The Workspace read route decodes the recorded path. The bytes arrive in
    // object storage through the durable-root sync, so this Turn's own answer
    // is a declared outcome, not a routing failure.
    const encoded = encodeURIComponent(storedResult!.attachments![0]!.path);
    const read = await asUser(
      userId,
      `/api/bots/${BOT_ID}/workspace/file?path=${encoded}`,
    );
    expect([200, 404, 409]).toContain(read.status);

    // A path the decoder refuses is a refusal, not a crash.
    const refused = await asUser(
      userId,
      `/api/bots/${BOT_ID}/workspace/file?path=${encodeURIComponent("{}")}`,
    );
    expect(refused.status).toBe(400);
  });
});
