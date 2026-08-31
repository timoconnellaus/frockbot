// `computer_screenshot`'s two host operations, on the real wire.
//
// The unit suite in `packages/plugin-fly-sprite/src/screenshot.test.ts` proves
// the script the provider builds against a double. What only exists here is
// the pair travelling the v1 protocol over a workerd service binding: one
// `exec` carrying the control guard and `scrot` under the tenant's display,
// then one `file/read` bringing the PNG off the Computer — and both landing on
// the same shard for one User, which is what makes a capture and its read-back
// the same Computer.
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, test } from "vitest";
import { computerBotKey } from "@frockbot/plugin-fly-sprite";
import type {
  FakeComputerHostCall,
  FakeExecScript,
} from "./computer-host-fake.ts";

const HOST = "http://computer-host.internal";
/** Where the provider tells `scrot` to write, and reads back from. */
function screenshotPath(botId: string): string {
  return `/home/box/.frockbot/bots/${computerBotKey(botId)}/screenshot.png`;
}

/** A 4x3 PNG: a real signature and a real IHDR. */
function pngBase64(): string {
  const bytes = new Uint8Array(32);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, 4);
  view.setUint32(20, 3);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
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

async function calls(): Promise<FakeComputerHostCall[]> {
  const response = await env.COMPUTER_HOST.fetch(
    new Request(`${HOST}/__fake/calls`),
  );
  const body = (await response.json()) as { calls: FakeComputerHostCall[] };
  return body.calls;
}

async function script(rule: FakeExecScript): Promise<void> {
  await post("/__fake/exec", rule);
}

// One fake Computer host serves the whole project and files run one at a
// time, so this file resets it once and owns its state for the duration.
beforeAll(async () => {
  const response = await env.COMPUTER_HOST.fetch(
    new Request(`${HOST}/__fake/reset`, { method: "POST" }),
  );
  expect(response.status).toBe(200);
});

describe("a screenshot through the shared Computer host", () => {
  test("runs one guarded scrot and reads the PNG back off the same shard", async () => {
    // `scrot` reports the size it wrote; the fake's Computer is a map, so the
    // bytes are seeded where the script would have put them.
    const path = screenshotPath("screenshot-ok");
    await script({ match: path, stdout: "32\n" });
    await post("/__fake/file-bytes", {
      userId: "workerd",
      path,
      bytesBase64: pngBase64(),
    });

    const captured =
      await env.FLY_COMPATIBILITY.getByName("screenshot").screenshot(
        "screenshot-ok",
      );

    expect(captured, JSON.stringify(captured)).toMatchObject({
      ok: true,
      mediaType: "image/png",
      display: ":100",
      bytesBase64: pngBase64(),
    });

    const recorded = (await calls()).filter(
      (call) => call.botId === "screenshot-ok",
    );
    const exec = recorded.find(
      (call) => call.kind === "exec" && call.script?.includes("scrot"),
    );
    const read = recorded.findLast((call) => call.kind === "file/read");
    expect(exec).toBeDefined();
    expect(exec!.script).toContain("control.sh assert-agent");
    expect(exec!.script).toContain("export DISPLAY=':100'");
    expect(read?.path).toBe(path);
    // One User, one Computer: the capture and the read-back must not be able
    // to land on two different shards.
    expect(read?.shard).toBe(exec!.shard);
    expect(read?.userId).toBe("workerd");
  });

  test("answers a capture that produced nothing rather than reading a file", async () => {
    await script({
      match: screenshotPath("screenshot-empty"),
      stdout: "",
      exitCode: 0,
    });

    const captured =
      await env.FLY_COMPATIBILITY.getByName("screenshot-empty").screenshot(
        "screenshot-empty",
      );

    expect(captured).toMatchObject({ ok: false });
    expect((captured as { message: string }).message).toContain(
      "produced no screenshot",
    );
    expect(
      (await calls()).some(
        (call) =>
          call.kind === "file/read" && call.botId === "screenshot-empty",
      ),
    ).toBe(false);
  });
});
