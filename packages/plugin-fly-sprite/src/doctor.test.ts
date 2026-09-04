/// <reference types="bun" />

// The Computer's self-check as this provider drives it (parity row 27), and
// the two policies that ride beside it: `/workspace` is shared scratch that no
// durable root covers, and the GUI is never driven from the shell.
import { describe, expect, test } from "bun:test";
import { ComputerError } from "@frockbot/computer-core";
import {
  BIN_ROOT,
  DOCTOR_MARKER,
  DOCTOR_SCRIPT,
  SCRATCH_ROOT,
  SHIMS_ROOT,
} from "@frockbot/computer-host-runtime";
import { FlySpriteComputer } from "./computer.ts";
import { FakeComputerHost } from "./host-double.ts";
import { FLY_WORKSPACE_LAYOUT } from "./provider.ts";

function report(generation: number): string {
  return `${DOCTOR_MARKER}${JSON.stringify({
    schemaVersion: 2,
    generation,
    capturedAt: "2026-09-01T00:00:00Z",
    checks: [
      {
        name: "watchdog",
        status: "pass",
        detail: "recent actions: none",
      },
      {
        name: "memory-top",
        status: "pass",
        detail: "123 2048 chromium",
      },
      { name: "disk-root", status: "pass", detail: "12% full" },
      { name: "dns", status: "fail", detail: "no resolver" },
    ],
    summary: "4 checks, 3 passed, 1 failed",
  })}\n`;
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

describe("doctorForAgent", () => {
  test("runs the installed script for the tenant and decodes its report", async () => {
    const host = new FakeComputerHost((script) =>
      script.includes(DOCTOR_SCRIPT) ? { stdout: report(1) } : {},
    );
    host.generation = 4;
    const bot = computerOn(host).bot("health");
    await bot.ensure(signal());

    const decoded = await bot.doctor(signal());

    expect(decoded.summary).toBe("4 checks, 3 passed, 1 failed");
    expect(decoded.checks.map((check) => check.status)).toEqual([
      "pass",
      "pass",
      "pass",
      "fail",
    ]);
    const script = host.scripts.find((candidate) =>
      candidate.includes(DOCTOR_SCRIPT),
    );
    // The Bot key and the generation the Computer is on: a report nobody told
    // which Computer it came from is a report nobody can date.
    expect(script).toContain(`${DOCTOR_SCRIPT} '${bot.botKey}' 4`);
    // Read-only and not lease-guarded: a Computer under human control is
    // exactly a Computer somebody may need to ask what is wrong with. The
    // stamp still runs, so asking cannot cost the tenant its display slot.
    expect(script).not.toContain("assert-agent");
    expect(script).toContain("last-seen");
  });

  test("answers a Computer with no self-check installed rather than crashing", async () => {
    // A Computer provisioned before the self-check existed. It gains one the
    // next time it is opened; until then, saying so is the whole job.
    const host = new FakeComputerHost((script) =>
      script.includes(DOCTOR_SCRIPT)
        ? { exitCode: 69, stderr: "missing\n" }
        : {},
    );
    const bot = computerOn(host).bot("health");
    await bot.ensure(signal());

    await expect(bot.doctor(signal())).rejects.toThrow(/no self-check/);
  });

  test("refuses output that is not a report", async () => {
    const host = new FakeComputerHost(() => ({ stdout: "all fine!\n" }));
    const bot = computerOn(host).bot("health");
    await bot.ensure(signal());

    const error = await bot.doctor(signal()).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ComputerError);
    expect((error as ComputerError).message).toContain("no readable report");
  });
});

describe("the tenant environment", () => {
  test("names the shared scratch and leads PATH with the Computer's own bin", async () => {
    const host = new FakeComputerHost();
    const bot = computerOn(host).bot("health");
    await bot.ensure(signal());

    await bot.exec("true", signal());

    const script = host.scripts.at(-1) ?? "";
    expect(script).toContain(`export PATH=${SHIMS_ROOT}:${BIN_ROOT}:$PATH`);
    expect(script).toContain(`export FROCKBOT_SCRATCH=${SCRATCH_ROOT}`);
    // The cwd stays the Bot's own workspace: a default cwd shared by every Bot
    // of a User is a default cwd where their files collide.
    expect(script).toContain(`cd '${bot.workingDirectory}'`);
    expect(script).not.toContain(`cd '${SCRATCH_ROOT}'`);
  });

  test("lets the screenshot past the shims, and an ordinary command never", async () => {
    // `scrot` is one of the shimmed names and `computer_screenshot` is the
    // surface the shim points at, so the capture sanctions itself and nothing
    // a Bot types does.
    const host = new FakeComputerHost((script) =>
      script.includes("scrot") ? { stdout: "64\n" } : {},
    );
    const png = new Uint8Array(64);
    png.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
    const bot = computerOn(host).bot("health");
    await bot.ensure(signal());
    host.files.set(
      `/home/box/.frockbot/bots/${bot.botKey}/screenshot.png`,
      png,
    );

    await bot.exec("true", signal());
    expect(host.scripts.at(-1)).not.toContain("FROCKBOT_SANCTIONED_SURFACE=1");

    await bot.screenshot(signal());
    expect(host.scripts.find((script) => script.includes("scrot"))).toContain(
      "export FROCKBOT_SANCTIONED_SURFACE=1",
    );
  });
});

describe("the durable-root layout", () => {
  test("declares no root for the shared scratch", () => {
    // "everything else on the Computer may be lost": `/workspace` is
    // deliberately outside the layout, so the sync never sees it and object
    // storage never holds it.
    for (const root of FLY_WORKSPACE_LAYOUT.roots) {
      expect(root.mountPath.startsWith(SCRATCH_ROOT)).toBe(false);
    }
    expect(JSON.stringify(FLY_WORKSPACE_LAYOUT)).not.toContain(
      `"${SCRATCH_ROOT}`,
    );
  });
});
