/// <reference types="bun" />

// `screenshotForAgent`: the two host operations a capture is made of.
//
// The subject is the pair — a guarded `exec` that runs `scrot` under the
// tenant's own display, and a `file/read` that brings the PNG back — because
// the pair is what makes the capture attributable. Leaving the file on the
// Computer would let the sync mirror it back `unattributed`, so the bytes must
// come off the Sprite before the Workspace writes them.
import { describe, expect, test } from "bun:test";
import { ComputerError } from "@frockbot/computer-core";
import { BOTS_ROOT } from "@frockbot/computer-host-runtime";
import {
  computerBotKey,
  FlySpriteComputer,
  SCREENSHOT_MAX_BYTES,
} from "./computer.ts";
import { FakeComputerHost } from "./host-double.ts";
import { FlySpriteComputerProvider } from "./provider.ts";

const KEY = computerBotKey("health");
const PATH = `${BOTS_ROOT}/${KEY}/screenshot.png`;

function png(): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  new DataView(bytes.buffer).setUint32(16, 1280);
  new DataView(bytes.buffer).setUint32(20, 720);
  return bytes;
}

function hostWith(size: number): FakeComputerHost {
  const host = new FakeComputerHost((script) =>
    script.includes("scrot") ? { stdout: `${size}\n` } : {},
  );
  host.files.set(PATH, png());
  return host;
}

function computerOn(host: FakeComputerHost): FlySpriteComputer {
  return new FlySpriteComputer({
    identity: { userId: "owner" },
    host: host.factory,
    spriteName: "frockbot-test",
  });
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

describe("screenshotForAgent", () => {
  test("runs scrot under the tenant's display behind the control guard, then reads the PNG back", async () => {
    const host = hostWith(64);
    const computer = computerOn(host);
    const bot = computer.bot("health");
    await bot.ensure(signal());

    const captured = await bot.screenshot(signal());

    const script = host.scripts.find((candidate) =>
      candidate.includes("scrot"),
    );
    expect(script).toBeDefined();
    // The human-control guard first, then the tenant's own display: a capture
    // during a takeover is the human's screen, so it is refused, not taken.
    expect(script!.indexOf("control.sh assert-agent")).toBeLessThan(
      script!.indexOf("scrot"),
    );
    expect(script).toContain("export DISPLAY=':100'");
    expect(script).toContain(`scrot --overwrite '${PATH}'`);
    // Read back rather than left on disk. That is the whole reason the
    // Workspace can record the Bot as the writer of these bytes.
    expect(host.reads).toEqual([{ botId: "health", path: PATH }]);
    expect(captured.display).toBe(":100");
    expect(captured.bytes.byteLength).toBe(64);
    expect(Date.parse(captured.capturedAt)).toBeGreaterThan(0);
  });

  test("refuses a capture while a human holds the takeover lease", async () => {
    const host = hostWith(64);
    const computer = computerOn(host);
    const bot = computer.bot("health");
    await bot.ensure(signal());
    host.leases.set(KEY, { owner: "a-human", fresh: true });

    await expect(bot.screenshot(signal())).rejects.toThrow(
      /controlling this agent's computer/,
    );
  });

  test("refuses a capture on a Computer that allocated no display", async () => {
    const host = hostWith(64);
    host.display = undefined;
    const computer = computerOn(host);
    const bot = computer.bot("health");
    await bot.ensure(signal());

    await expect(bot.screenshot(signal())).rejects.toThrow(
      /no desktop on this Computer to capture/,
    );
    expect(host.reads).toEqual([]);
  });

  test("refuses a capture past the size limit before it reads any bytes", async () => {
    const host = hostWith(SCREENSHOT_MAX_BYTES + 1);
    const computer = computerOn(host);
    const bot = computer.bot("health");
    await bot.ensure(signal());

    const failure = await bot
      .screenshot(signal())
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ComputerError);
    expect((failure as ComputerError).code).toBe("limit-exceeded");
    expect(host.reads).toEqual([]);
  });

  test("answers an absent capture rather than an empty picture", async () => {
    const host = new FakeComputerHost(() => ({ stdout: "" }));
    const computer = computerOn(host);
    const bot = computer.bot("health");
    await bot.ensure(signal());

    await expect(bot.screenshot(signal())).rejects.toThrow(
      /produced no screenshot/,
    );
  });

  test("reaches the provider-neutral Computer interface as a PNG capture", async () => {
    const host = hostWith(64);
    const provider = new FlySpriteComputerProvider(computerOn(host));
    const handle = await provider.open(
      { userId: "owner" },
      { botId: "health" },
      { providerId: "fly-sprite", generation: 1 },
    );

    const captured = await handle.screenshot!.capture({ signal: signal() });

    expect(captured.mediaType).toBe("image/png");
    expect(captured.display).toBe(":100");
    expect(captured.bytes.byteLength).toBe(64);
  });
});
