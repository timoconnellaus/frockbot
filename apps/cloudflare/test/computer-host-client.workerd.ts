// `ComputerHostClient` in real workerd, from inside a real Durable Object,
// against the fake Computer host on a real service binding.
//
// The unit tests in `packages/plugin-fly-sprite/src/host-client.test.ts` prove
// the client's logic against a hand-written fetcher. They cannot prove the two
// things that only exist here: that a workerd `Fetcher` behaves the way the
// client assumes when a body streams and when a request aborts, and that a
// Computer effect leaves a durable record a recovery could read. Both are
// asserted through `ComputerHostClientProbe`, whose storage is real Durable
// Object storage.
import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import type {
  FakeComputerHostCall,
  FakeExecScript,
} from "./computer-host-fake.ts";
import type { ComputerHostClientProbe } from "./computer-host-probe.ts";

const HOST = "http://computer-host.internal";

function probe(name = "computer-host-client") {
  return env.COMPUTER_HOST_CLIENT.getByName(name);
}

async function resetHost(): Promise<void> {
  const response = await env.COMPUTER_HOST.fetch(
    new Request(`${HOST}/__fake/reset`, { method: "POST" }),
  );
  expect(response.status).toBe(200);
}

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

async function calls(): Promise<FakeComputerHostCall[]> {
  const response = await env.COMPUTER_HOST.fetch(
    new Request(`${HOST}/__fake/calls`),
  );
  const body = (await response.json()) as { calls: FakeComputerHostCall[] };
  return body.calls;
}

async function effects(
  name?: string,
): Promise<Awaited<ReturnType<ComputerHostClientProbe["effects"]>>> {
  return probe(name).effects();
}

beforeEach(async () => {
  await resetHost();
  await probe().clear();
  await probe("second-user").clear();
});

describe("the Durable Object's Computer host client", () => {
  test("sends the v1 envelope the host decodes, and no credential", async () => {
    await script({ stdout: "ok\n" });
    const result = await probe().exec({
      effectId: "effect-envelope",
      script: "echo ok",
      userId: "user-a",
      botId: "bot-a",
    });

    expect(result.ok).toBe(true);
    const [call] = await calls();
    expect(call?.kind).toBe("exec");
    expect(call?.effectId).toBe("effect-envelope");
    expect(call?.userId).toBe("user-a");
    expect(call?.botId).toBe("bot-a");
    // What crosses the seam is a reference, never a token. `SPRITES_TOKEN`
    // lives on the host Worker and reaches only the container's env.
    expect(call?.credentialRef).toBe("sprites:user:user-a");
    expect(JSON.stringify(call)).not.toContain("SPRITES_TOKEN");
  });

  test("every Bot of one User routes to one container", async () => {
    await script({ stdout: "ok\n" });
    await probe().exec({
      effectId: "effect-bot-1",
      script: "echo one",
      userId: "user-shared",
      botId: "bot-one",
    });
    await probe().exec({
      effectId: "effect-bot-2",
      script: "echo two",
      userId: "user-shared",
      botId: "bot-two",
    });
    const routed = await calls();
    // ADR 0012: a Computer is keyed by User. Two Bots of one User landing on
    // two containers would race on one Sprite's slot registry and lease.
    expect(routed[0]?.shard).toBe(routed[1]?.shard ?? "");
  });

  test("reassembles a stream whose chunks split frames", async () => {
    await script({
      frames: [
        { type: "stdout", dataBase64: btoa("first\n") },
        { type: "stderr", dataBase64: btoa("warned\n") },
        { type: "stdout", dataBase64: btoa("second\n") },
        { type: "exit", exitCode: 3, outputTruncated: false },
      ],
      // Far smaller than one frame, so no chunk is ever a frame.
      chunkBytes: 3,
    });
    const result = await probe().exec({
      effectId: "effect-stream",
      script: "echo first",
    });

    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("first\nsecond\n");
    expect(result.stderr).toBe("warned\n");
    expect(result.exitCode).toBe(3);
    expect((await effects())[0]).toMatchObject({
      effectId: "effect-stream",
      status: "completed",
      exitCode: 3,
    });
  });

  test("bounds output at maxOutputBytes and still reads the exit frame", async () => {
    await script({
      frames: [
        { type: "stdout", dataBase64: btoa("0123456789") },
        { type: "stdout", dataBase64: btoa("abcdefghij") },
        { type: "exit", exitCode: 0, outputTruncated: false },
      ],
      chunkBytes: 5,
    });
    const result = await probe().exec({
      effectId: "effect-truncate",
      script: "yes",
      maxOutputBytes: 12,
    });

    expect(result.stdout).toBe("0123456789ab");
    expect(result.outputTruncated).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  test("a caller's cancellation is durable, and names the effect it killed", async () => {
    await script({ hangMs: 20_000 });
    const result = await probe().exec({
      effectId: "effect-cancelled",
      script: "sleep 600",
      abortAfterMs: 50,
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("aborted");
    // The abort alone would leave the process running on the Computer: a
    // dropped connection is not a stop signal. The client posts a cancel.
    await scheduler.wait(200);
    const cancels = (await calls()).filter((call) => call.kind === "cancel");
    expect(cancels.map((call) => call.effectId)).toContain("effect-cancelled");
    expect((await effects())[0]).toMatchObject({
      effectId: "effect-cancelled",
      status: "refused",
      code: "aborted",
    });
  });

  test("a host that never answers becomes a retryable unavailability", async () => {
    await script({ hangMs: 20_000 });
    const result = await probe().exec({
      effectId: "effect-timeout",
      script: "sleep 600",
      // The client waits this plus its grace, then gives up on its own.
      timeoutMs: 50,
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("provider-unavailable");
    expect(result.retryable).toBe(true);
    expect((await effects())[0]).toMatchObject({
      status: "refused",
      code: "provider-unavailable",
      retryable: true,
    });
  });

  test("a shed load answers limit-exceeded and says it may be retried", async () => {
    await script({
      refuse: {
        status: 429,
        code: "limit-exceeded",
        message: "This Computer is already running 4 effects",
      },
    });
    const result = await probe().exec({
      effectId: "effect-429",
      script: "echo busy",
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("limit-exceeded");
    expect(result.retryable).toBe(true);
    expect(result.message).toContain("already running 4 effects");
  });

  test("a wrong host token is refused before any Computer is touched", async () => {
    const result = await probe().execWithWrongToken({
      effectId: "effect-token",
      script: "echo secret",
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("provider-failure");
    expect(result.retryable).toBe(false);
    // Refused at the token check, so the request never reached the decoder.
    expect(await calls()).toHaveLength(0);
  });

  test("the host refuses a body its schema does not declare", async () => {
    const refused = await probe().postUndecodable({
      version: 1,
      effectId: "effect-smuggle",
      identity: { userId: "user-probe" },
      tenant: { botId: "bot-probe" },
      credentialRef: "sprites:user:user-probe",
      script: "echo hi",
      timeoutMs: 1_000,
      maxOutputBytes: 1_000,
      stream: false,
      smuggled: "value",
    });
    expect(refused.status).toBe(400);

    const wrongVersion = await probe().postUndecodable({
      version: 2,
      effectId: "effect-version",
      identity: { userId: "user-probe" },
      tenant: { botId: "bot-probe" },
      credentialRef: "sprites:user:user-probe",
      script: "echo hi",
      timeoutMs: 1_000,
      maxOutputBytes: 1_000,
      stream: false,
    });
    expect(wrongVersion.status).toBe(400);

    const overLimit = await probe().postUndecodable({
      version: 1,
      effectId: "effect-limit",
      identity: { userId: "user-probe" },
      tenant: { botId: "bot-probe" },
      credentialRef: "sprites:user:user-probe",
      script: "echo hi",
      timeoutMs: 1_000,
      // Past the declared ceiling: refused as a limit, not as a bad field.
      maxOutputBytes: 64 * 1_024 * 1_024,
      stream: false,
    });
    expect(overLimit.status).toBe(413);
  });

  test("a buffered exec answers one result", async () => {
    await script({ stdout: "buffered\n", exitCode: 0 });
    const result = await probe().exec({
      effectId: "effect-buffered",
      script: "echo buffered",
      stream: false,
    });
    expect(result.stdout).toBe("buffered\n");
    expect((await calls())[0]?.stream).toBe(false);
  });

  test("open answers the Computer this User's Bots share", async () => {
    const opened = await probe().open({
      effectId: "effect-open",
      userId: "user-open",
    });
    expect(opened.ok).toBe(true);
    expect(opened.spriteName).toMatch(/^frockbot-fake-/);
    expect((await calls())[0]?.stream).toBe(true);
  });

  test("file bytes round-trip through the host, never through a shell", async () => {
    const result = await probe().fileRoundTrip({
      effectId: "effect-file",
      path: "/home/box/agent-data/probe.txt",
      text: "bytes with a ' quote and a \\ backslash\n",
    });
    expect(result.ok).toBe(true);
    expect(result.text).toBe("bytes with a ' quote and a \\ backslash\n");
    const written = (await calls()).filter(
      (call) => call.kind === "file/write",
    );
    expect(written[0]?.path).toBe("/home/box/agent-data/probe.txt");
  });

  test("the recorded effect survives the Durable Object it was recorded in", async () => {
    await script({ stdout: "durable\n" });
    await probe().exec({ effectId: "effect-durable", script: "echo durable" });
    // A fresh instance reads the same storage: the effect record is durable
    // state, not an in-process memo.
    await runInDurableObject(probe(), () => {});
    const held = await env.COMPUTER_HOST_CLIENT.getByName(
      "computer-host-client",
    ).effects();
    expect(held).toHaveLength(1);
    expect(held[0]?.status).toBe("completed");
  });
});
