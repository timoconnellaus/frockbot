/// <reference types="bun" />

// Background processes as the provider drives them.
//
// The subject is the shape of the three scripts, because each one encodes a
// decision that is invisible anywhere else: `setsid` makes the command a
// process group leader so a later stop can end its whole tree; the stop
// escalates TERM to KILL rather than assuming a signal was obeyed; and the
// read carries no human-control guard, because collecting the outcome of a
// long job is not the Bot acting on the screen.
import { describe, expect, test } from "bun:test";
import {
  computerBotKey,
  FlySpriteComputer,
  PROCESS_STOP_GRACE_SECONDS,
} from "./computer.ts";
import { FakeComputerHost } from "./host-double.ts";

const KEY = computerBotKey("worker");
const DIR = `/home/box/.frockbot/bots/${KEY}/processes/p-1`;

function signal(): AbortSignal {
  return new AbortController().signal;
}

function computerOn(host: FakeComputerHost): FlySpriteComputer {
  return new FlySpriteComputer({
    identity: { userId: "owner" },
    host: host.factory,
    spriteName: "frockbot-test",
  });
}

/** A Computer that answers the launch with a pid and the read with a state. */
function fakeComputer(
  answers: {
    pid?: number;
    alive?: boolean;
    exitCode?: number;
    log?: string;
  } = {},
): FakeComputerHost {
  return new FakeComputerHost((script) => {
    if (script.includes("setsid nohup")) {
      return { stdout: `__FROCKBOT_PROCESS__${answers.pid ?? 4242}\n` };
    }
    if (script.includes("%salive=%s")) {
      return {
        stdout: [
          `__FROCKBOT_PROCESS__alive=${answers.alive ? 1 : 0}`,
          ...(answers.exitCode === undefined
            ? []
            : [`__FROCKBOT_PROCESS__exit=${answers.exitCode}`]),
          "__FROCKBOT_PROCESS__log",
          answers.log ?? "",
        ].join("\n"),
      };
    }
    return {};
  });
}

describe("launching a background process", () => {
  test("detaches it into its own process group behind the control guard", async () => {
    const host = fakeComputer({ pid: 9182 });
    const bot = computerOn(host).bot("worker");
    await bot.ensure(signal());

    const launched = await bot.launchProcess("p-1", "npm run build", signal());

    const script = host.scripts.find((candidate) =>
      candidate.includes("setsid nohup"),
    )!;
    expect(script).toBeDefined();
    // Guarded like every other Bot command: a launch is a mutation.
    expect(script.indexOf("control.sh assert-agent")).toBeLessThan(
      script.indexOf("setsid nohup"),
    );
    // `setsid` is what makes `kill -TERM -$PID` reach the whole pipeline
    // later, instead of orphaning the children of a shell.
    expect(script).toContain("setsid nohup bash -c");
    expect(script).toContain("bounded-log.sh");
    // The exit code recorded is the command's, not the logger's.
    expect(script).toContain("PIPESTATUS[0]");
    expect(script).toContain(`> "$DIR/pid"`);
    expect(launched).toEqual({
      pid: 9182,
      logPath: `${DIR}/log`,
      cwd: `/workspaces/${KEY}`,
    });
  });

  test("refuses a launch the Computer did not start", async () => {
    const host = new FakeComputerHost(() => ({ stdout: "" }));
    const bot = computerOn(host).bot("worker");
    await bot.ensure(signal());

    await expect(
      bot.launchProcess("p-1", "sleep 60", signal()),
    ).rejects.toThrow(/started no background process/);
  });

  test("is refused while a human holds the takeover lease", async () => {
    const host = fakeComputer();
    const computer = computerOn(host);
    const bot = computer.bot("worker");
    await bot.ensure(signal());
    host.leases.set(KEY, { owner: "a-human", fresh: true });

    await expect(
      bot.launchProcess("p-1", "sleep 60", signal()),
    ).rejects.toThrow(/controlling this agent's computer/);
  });
});

describe("reading a background process", () => {
  test("answers liveness, exit code and the bounded log", async () => {
    const host = fakeComputer({
      alive: false,
      exitCode: 3,
      log: "build failed",
    });
    const bot = computerOn(host).bot("worker");
    await bot.ensure(signal());

    const state = await bot.inspectProcess("p-1", signal());

    expect(state).toMatchObject({ alive: false, exitCode: 3 });
    expect(state.logTail).toContain("build failed");
    const script = host.scripts.at(-1)!;
    // Both halves of the capped log are composed at read time.
    expect(script).toContain('"$DIR/log.head"');
    expect(script).toContain('"$DIR/log.tail"');
  });

  test("carries no human-control guard, so a Routine can still collect it", async () => {
    const host = fakeComputer({ alive: true });
    const computer = computerOn(host);
    const bot = computer.bot("worker");
    await bot.ensure(signal());
    host.leases.set(KEY, { owner: "a-human", fresh: true });

    // A human holding the screen must not stop a Bot from learning what
    // became of a job it started before the takeover.
    const state = await bot.inspectProcess("p-1", signal());

    expect(state.alive).toBe(true);
    const script = host.scripts.at(-1)!;
    expect(script).not.toContain("assert-agent");
    // The slot stamp still runs: a tenant with a running process is live.
    expect(script).toContain("last-seen");
  });
});

describe("stopping a background process", () => {
  test("escalates TERM to KILL over the process group and records an exit", async () => {
    const host = fakeComputer({ alive: false, exitCode: 143 });
    const bot = computerOn(host).bot("worker");
    await bot.ensure(signal());

    const state = await bot.stopProcess("p-1", signal());

    const script = host.scripts.find((candidate) =>
      candidate.includes("kill -TERM"),
    )!;
    expect(script).toBeDefined();
    // The negative pid is the group: a pipeline's children go with it.
    expect(script).toContain('kill -TERM -"$PID"');
    expect(script).toContain('kill -KILL -"$PID"');
    expect(script).toContain(`seq 1 ${PROCESS_STOP_GRACE_SECONDS * 10}`);
    // A stopped process must not read back as `unknown` for want of an exit
    // file the signal never let it write.
    expect(script).toContain(`'143\\n' > "$DIR/exit"`);
    expect(state).toMatchObject({ alive: false, exitCode: 143 });
  });
});
