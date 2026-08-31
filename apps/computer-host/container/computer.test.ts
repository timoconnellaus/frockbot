import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  COMPUTER_HOST_ROUTES,
  ComputerHostExecFrameReaderV1,
  decodeComputerHostCancelResultV1,
  decodeComputerHostControlResultV1,
  decodeComputerHostExecResultV1,
  decodeComputerHostFileListResultV1,
  decodeComputerHostFileReadResultV1,
  decodeComputerHostHttpRequestV1,
  decodeComputerHostOpenResultV1,
  decodeComputerHostProblemV1,
  decodeComputerHostServiceResultV1,
  type ComputerHostExecFrameV1,
  type ComputerHostOperationV1,
  type ComputerHostRequestV1,
} from "@frockbot/computer-host-protocol";
import {
  CONTROL_SCRIPT,
  DESKTOP_SERVICE,
  ENSURE_AGENT_SCRIPT,
  NO_SLOTS_MARKER,
  PROVISION_MARKERS,
  PROVISION_PHASES,
  PROVISION_RUNNER_PREFIX,
  PROVISION_SCRIPT,
  provisionScript,
  RUNTIME_ROOT,
  WORKSPACE_SYNC_SERVICE,
} from "@frockbot/computer-host-runtime";
import {
  ComputerHost,
  COMPUTER_HOST_STATE_PATH,
  computerHostExecScriptV1,
  readProvisionObservation,
} from "./computer.ts";
import { FakeSprite, FakeSpritesClient } from "./fake-sprites.ts";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

function hostWith(
  client: FakeSpritesClient,
  concurrency?: {
    perContainer: number;
    perUser: number;
  },
): ComputerHost {
  return new ComputerHost({
    client,
    baseSpriteName: "frockbot",
    digest,
    now: () => Date.parse("2026-08-31T00:00:00.000Z"),
    // The real gap is three seconds. A test that polls a fake provisioner
    // should not spend them.
    provisionPollMs: 1,
    ...(concurrency ? { concurrency } : {}),
  });
}

/**
 * What the launcher and the poll script print: whether a provisioner still
 * holds the run lock, then the phase it last recorded.
 */
function report(
  runner: "running" | "stopped",
  phase?: {
    index: number;
    name: string;
    label: string;
    status: "running" | "complete" | "failed";
  },
): { stdout: string[]; exitCode: number } {
  const lines = [`${PROVISION_RUNNER_PREFIX}${runner}\n`];
  if (phase) {
    lines.push(
      `${JSON.stringify({
        version: 1,
        index: phase.index,
        total: PROVISION_PHASES.length,
        phase: phase.name,
        label: phase.label,
        status: phase.status,
      })}\n`,
    );
  }
  return { stdout: lines, exitCode: 0 };
}

const installing = {
  index: 2,
  name: "packages",
  label: "installing the desktop packages",
  status: "running",
} as const;

const ready = {
  index: PROVISION_PHASES.length,
  name: "ready",
  label: "the Computer is ready",
  status: "complete",
} as const;

function request(
  operation: ComputerHostOperationV1,
  overrides: Partial<ComputerHostRequestV1> = {},
): ComputerHostRequestV1 {
  return {
    version: 1,
    effectId: "effect-1",
    identity: { userId: "user-1" },
    tenant: { botId: "bot-1" },
    credentialRef: "sprites:user:user-1",
    operation,
    ...overrides,
  };
}

const exec = (
  overrides: Partial<Extract<ComputerHostOperationV1, { kind: "exec" }>> = {},
): ComputerHostOperationV1 => ({
  kind: "exec",
  script: "printf hello",
  timeoutMs: 5_000,
  maxOutputBytes: 64 * 1_024,
  stream: false,
  ...overrides,
});

/** A Sprite already provisioned, so a test can go straight to the operation. */
function provisioned(userId = "user-1"): {
  client: FakeSpritesClient;
  host: ComputerHost;
  sprite: FakeSprite;
} {
  const client = new FakeSpritesClient();
  const host = hostWith(client);
  const name = host.spriteNameFor(userId);
  const sprite = new FakeSprite(name);
  client.sprites.set(name, sprite);
  writeFile(
    sprite,
    COMPUTER_HOST_STATE_PATH,
    JSON.stringify({ version: 1, generation: 4 }),
  );
  writeFile(
    sprite,
    `/home/box/.frockbot/bots/bot-1-${digest("bot-1").slice(0, 12)}/slot`,
    "7\n",
  );
  return { client, host, sprite };
}

function writeFile(sprite: FakeSprite, path: string, content: string): void {
  sprite.files.set(path, {
    bytes: Buffer.from(content),
    mode: 0o600,
    mtime: new Date("2026-08-31T00:00:00.000Z"),
  });
}

async function readFrames(
  response: Response,
): Promise<ComputerHostExecFrameV1[]> {
  const reader = new ComputerHostExecFrameReaderV1();
  const frames: ComputerHostExecFrameV1[] = [];
  const body = response.body;
  if (!body) return frames;
  const stream = body.getReader();
  for (;;) {
    const { done, value } = await stream.read();
    if (done) break;
    frames.push(...reader.push(value));
  }
  frames.push(...reader.end());
  return frames;
}

describe("Sprite naming", () => {
  test("derives one Sprite per User, from the User alone", () => {
    const host = hostWith(new FakeSpritesClient());
    expect(host.spriteNameFor("user-1")).toMatch(/^frockbot-[0-9a-f]{12}$/);
    expect(host.spriteNameFor("user-1")).toBe(host.spriteNameFor("user-1"));
    expect(host.spriteNameFor("user-1")).not.toBe(host.spriteNameFor("user-2"));
  });

  test("honours an overridden base name so a test run gets its own Sprite", () => {
    const host = new ComputerHost({
      client: new FakeSpritesClient(),
      baseSpriteName: "frockbot-test-abc",
      digest,
    });
    expect(host.spriteNameFor("user-1")).toStartWith("frockbot-test-abc-");
  });
});

describe("open", () => {
  test("provisions a new Computer and adopts it thereafter", async () => {
    const client = new FakeSpritesClient();
    const host = hostWith(client);
    client.onCreate = (sprite) => {
      sprite.scripts = [
        report("running", installing),
        report("running", installing),
        report("stopped", ready),
      ];
    };
    const response = await host.handle(request({ kind: "open" }));
    expect(response.status).toBe(200);
    const result = decodeComputerHostOpenResultV1(await response.json());
    expect(result.spriteName).toBe(host.spriteNameFor("user-1"));
    expect(result.generation).toBe(1);
    expect(client.created).toEqual([host.spriteNameFor("user-1")]);

    const sprite = client.only();
    expect(sprite.services.has(DESKTOP_SERVICE)).toBe(true);
    expect(sprite.services.has(WORKSPACE_SYNC_SERVICE)).toBe(true);
    expect(sprite.urlSettings).toEqual({ auth: "public" });
    expect(sprite.files.has(COMPUTER_HOST_STATE_PATH)).toBe(true);

    // The second open adopts what the first provisioned: no launcher, no
    // phases to report, and no Bot reinstalling its own desktop on turn two.
    const again = decodeComputerHostOpenResultV1(
      await (await host.handle(request({ kind: "open" }))).json(),
    );
    expect(again.provisioning).toBeUndefined();
    expect(
      sprite.commands.filter((command) => command.stdin.includes("setsid")),
    ).toHaveLength(1);
  });

  test("ships the provisioning script on stdin and never on argv", async () => {
    const client = new FakeSpritesClient();
    const host = hostWith(client);
    client.onCreate = (sprite) => {
      sprite.scripts = [report("stopped", ready)];
    };
    await host.handle(request({ kind: "open" }));
    const [first] = client.only().commands;
    // The regression the 431 taught: the script is thousands of bytes, and it
    // must be in the one place with no size limit.
    expect(first?.command).toBe("bash");
    expect(first?.args).toEqual(["-s"]);
    expect(first?.stdin).toContain(
      Buffer.from(provisionScript).toString("base64"),
    );
    expect(JSON.stringify(first?.args).length).toBeLessThan(32);
    expect(first?.stdin.length).toBeGreaterThan(3_000);
  });

  test("launches the provisioner detached and then only polls it", async () => {
    // The defect this is the fix for: `@fly/sprites@0.1.0` gives up on a
    // WebSocket after 45 s with no inbound message and never pings, so the
    // exec that installs a desktop stack cannot be the exec that waits for it.
    const client = new FakeSpritesClient();
    const host = hostWith(client);
    client.onCreate = (sprite) => {
      sprite.scripts = [
        report("running", installing),
        report("running", installing),
        report("stopped", ready),
      ];
    };
    const response = await host.handle(request({ kind: "open" }));
    expect(response.status).toBe(200);
    const result = decodeComputerHostOpenResultV1(await response.json());
    expect(result.provisioning?.status).toBe("complete");
    expect(result.provisioning?.total).toBe(PROVISION_PHASES.length);
    expect(result.provisioning?.resumed).toBe(false);

    const [launch, ...rest] = client.only().commands;
    expect(launch?.stdin).toContain("setsid nohup");
    expect(launch?.stdin).toContain(PROVISION_SCRIPT);
    // Every later command is short. None of them carries the document, and
    // none of them starts anything, so none of them can be quiet for 45 s.
    const polls = rest.filter((command) =>
      command.stdin.includes(PROVISION_RUNNER_PREFIX),
    );
    expect(polls.length).toBeGreaterThan(0);
    for (const poll of polls) {
      expect(poll.stdin).not.toContain("setsid");
      expect(poll.stdin.length).toBeLessThan(1_000);
    }
  });

  test("completes a half-provisioned Computer instead of starting over", async () => {
    const client = new FakeSpritesClient();
    const host = hostWith(client);
    client.onCreate = (sprite) => {
      // The marker the earlier run left behind: phase one is done, so this
      // run is a resume and the desktop packages are not installed twice.
      writeFile(sprite, `${PROVISION_MARKERS}/layout`, "");
      sprite.scripts = [
        report("running", installing),
        report("stopped", ready),
      ];
    };
    const response = await host.handle(request({ kind: "open" }));
    expect(response.status).toBe(200);
    const result = decodeComputerHostOpenResultV1(await response.json());
    expect(result.provisioning?.resumed).toBe(true);
    expect(result.provisioning?.status).toBe("complete");
    // The document the launcher installs is the resumable one: every phase is
    // guarded by its own marker.
    expect(client.only().commands[0]?.stdin).toContain(
      Buffer.from(provisionScript).toString("base64"),
    );
    expect(provisionScript).toContain(`[ ! -f "$MARKERS/layout" ]`);
  });

  test("restarts a provisioner that went away, from its markers", async () => {
    const client = new FakeSpritesClient();
    const host = hostWith(client);
    client.onCreate = (sprite) => {
      writeFile(sprite, `${PROVISION_MARKERS}/layout`, "");
      sprite.scripts = [
        // The launch, then three polls that find nobody holding the run lock:
        // the provisioner died mid-phase, which a container restart looks
        // exactly like.
        report("stopped", installing),
        report("stopped", installing),
        report("stopped", installing),
        // The relaunch picks it up where the markers left it.
        report("running", installing),
        report("stopped", ready),
      ];
    };
    const response = await host.handle(request({ kind: "open" }));
    expect(response.status).toBe(200);
    const result = decodeComputerHostOpenResultV1(await response.json());
    expect(result.provisioning?.status).toBe("complete");
    expect(result.provisioning?.resumed).toBe(true);
    const launches = client
      .only()
      .commands.filter((command) => command.stdin.includes("setsid nohup"));
    expect(launches).toHaveLength(2);
  });

  test("a poll that fails does not end an install running detached", async () => {
    // "Connections to the Computer are expected to drop on every pause." The
    // install is not on the connection, so losing one costs a poll.
    const client = new FakeSpritesClient();
    const host = hostWith(client);
    client.onCreate = (sprite) => {
      sprite.scripts = [
        report("running", installing),
        { error: "socket hang up" },
        { error: "socket hang up" },
        report("running", installing),
        report("stopped", ready),
      ];
    };
    const response = await host.handle(request({ kind: "open" }));
    expect(response.status).toBe(200);
    expect(
      decodeComputerHostOpenResultV1(await response.json()).provisioning
        ?.status,
    ).toBe("complete");
  });

  test("a command that reports the same failure twice does not kill the host", async () => {
    // Measured against a real Sprite: a WebSocket that never opened emitted
    // `error` twice, the second landed on an emitter with no listener left,
    // and Node took the container down — every other User's work with it.
    const client = new FakeSpritesClient();
    const host = hostWith(client);
    client.onCreate = (sprite) => {
      sprite.scripts = [
        report("running", installing),
        {
          error: "WebSocket closed before open: code=1006",
          errorEmissions: 3,
        },
        report("running", installing),
        report("stopped", ready),
      ];
    };
    const response = await host.handle(request({ kind: "open" }));
    expect(response.status).toBe(200);
  });

  test("a Computer that stops answering is reported as unavailable", async () => {
    const client = new FakeSpritesClient();
    // A clock that jumps a minute per reading, so the run reaches its silence
    // budget without the test waiting for it.
    let clock = Date.parse("2026-08-31T00:00:00.000Z");
    const host = new ComputerHost({
      client,
      baseSpriteName: "frockbot",
      digest,
      provisionPollMs: 1,
      now: () => (clock += 60_000),
    });
    client.onCreate = (sprite) => {
      sprite.scripts = [
        report("running", installing),
        { error: "socket hang up" },
      ];
    };
    const response = await host.handle(request({ kind: "open" }));
    expect(response.status).toBe(503);
    const failure = decodeComputerHostProblemV1(await response.json());
    expect(failure.code).toBe("provider-unavailable");
    expect(failure.message).toContain("installing the desktop packages (2/5)");
  });

  test("names the phase a failed provisioning run stopped in", async () => {
    const client = new FakeSpritesClient();
    const host = hostWith(client);
    client.onCreate = (sprite) => {
      sprite.scripts = [
        report("running", installing),
        report("stopped", { ...installing, status: "failed" }),
        { stdout: ["E: Unable to fetch chromium\n"], exitCode: 0 },
      ];
    };
    const response = await host.handle(request({ kind: "open" }));
    expect(response.status).toBe(502);
    const failure = decodeComputerHostProblemV1(await response.json());
    expect(failure.message).toContain("installing the desktop packages (2/5)");
    expect(failure.message).toContain("Unable to fetch chromium");
    expect(failure.retryable).toBe(true);
  });

  test("a provisioner that vanished is reported, not waited on", async () => {
    const client = new FakeSpritesClient();
    const host = hostWith(client);
    client.onCreate = (sprite) => {
      // Nothing holds the lock and nothing ever reaches "complete".
      sprite.scripts = [report("stopped", installing)];
    };
    const response = await host.handle(request({ kind: "open" }));
    expect(response.status).toBe(502);
    expect(
      decodeComputerHostProblemV1(await response.json()).message,
    ).toContain("installing the desktop packages (2/5)");
  });

  test("attaches the tenant through the ensure script and reports its display", async () => {
    const { host, sprite } = provisioned();
    const response = await host.handle(request({ kind: "open" }));
    const result = decodeComputerHostOpenResultV1(await response.json());
    expect(result.generation).toBe(4);
    expect(result.display).toBe(":107");
    expect(result.directory).toBe(
      `/home/box/agent-data/agents/bot-1-${digest("bot-1").slice(0, 12)}`,
    );
    expect(sprite.commands.at(-1)?.stdin).toContain(ENSURE_AGENT_SCRIPT);
  });

  test("adopts a Sprite it did not provision, so a restart repeats no effect", async () => {
    const { client, host } = provisioned();
    await host.handle(request({ kind: "open" }));
    expect(client.created).toEqual([]);
    expect(
      client
        .only()
        .commands.some((command) => command.stdin.includes("apt-get install")),
    ).toBe(false);
  });

  test("refuses when every desktop slot belongs to a live tenant", async () => {
    const { host, sprite } = provisioned();
    sprite.scripts = [{ stdout: [`${NO_SLOTS_MARKER}\n`], exitCode: 75 }];
    const response = await host.handle(request({ kind: "open" }));
    expect(response.status).toBe(409);
    const problem = decodeComputerHostProblemV1(await response.json());
    expect(problem.code).toBe("conflict");
    expect(problem.retryable).toBe(true);
  });
});

describe("provisioning reports", () => {
  test("reads the phase and the run lock out of one report", () => {
    const observation = readProvisionObservation(
      `${PROVISION_RUNNER_PREFIX}running\n${JSON.stringify({
        version: 1,
        index: 3,
        total: 5,
        phase: "runtime",
        label: "installing the Computer runtime",
        status: "running",
      })}\n`,
    );
    expect(observation).toMatchObject({
      phase: "runtime",
      index: 3,
      total: 5,
      status: "running",
      running: true,
    });
  });

  test("a Sprite that has never been asked reads as the starting phase", () => {
    const observation = readProvisionObservation(
      `${PROVISION_RUNNER_PREFIX}stopped\n`,
    );
    expect(observation.index).toBe(0);
    expect(observation.status).toBe("running");
    expect(observation.running).toBe(false);
  });

  test("an unparseable line does not become a false completion", () => {
    const observation = readProvisionObservation(
      `${PROVISION_RUNNER_PREFIX}running\n{ this is not json\n`,
    );
    expect(observation.status).toBe("running");
  });
});

describe("exec", () => {
  test("compiles cwd and env into the script rather than the SDK options", () => {
    const script = computerHostExecScriptV1({
      kind: "exec",
      script: "printf hi",
      cwd: "/workspaces/bot",
      env: { FROCKBOT_BOT_ID: "bot 1", QUOTED: "it's" },
      timeoutMs: 1,
      maxOutputBytes: 1,
      stream: false,
    });
    // Both would otherwise reach the WebSocket URL, where the 431 lives.
    expect(script).toContain("export FROCKBOT_BOT_ID='bot 1'");
    expect(script).toContain(`export QUOTED='it'"'"'s'`);
    expect(script).toContain("cd '/workspaces/bot'");
    expect(script.endsWith("printf hi\n")).toBe(true);
  });

  test("returns a buffered result with the script delivered on stdin", async () => {
    const { host, sprite } = provisioned();
    sprite.scripts = [{ stdout: ["hello"], exitCode: 0 }];
    const response = await host.handle(
      request(exec({ script: "printf hello" })),
    );
    const result = decodeComputerHostExecResultV1(await response.json());
    expect(result.exitCode).toBe(0);
    expect(Buffer.from(result.stdoutBase64, "base64").toString()).toBe("hello");
    expect(result.outputTruncated).toBe(false);
    expect(sprite.commands.at(-1)?.stdin).toContain("printf hello");
    expect(sprite.commands.at(-1)?.args).toEqual(["-s"]);
  });

  test("carries a script far larger than the argv limit", async () => {
    const { host, sprite } = provisioned();
    const script = `# ${"x".repeat(64_000)}\ntrue`;
    await host.handle(request(exec({ script })));
    expect(sprite.commands.at(-1)?.stdin).toContain(script);
  });

  test("appends extra stdin after the script", async () => {
    const { host, sprite } = provisioned();
    await host.handle(
      request(
        exec({
          script: "cat",
          stdinBase64: Buffer.from("payload").toString("base64"),
        }),
      ),
    );
    expect(sprite.commands.at(-1)?.stdin).toEndWith("payload");
  });

  test("reports a non-zero exit code rather than throwing", async () => {
    const { host, sprite } = provisioned();
    sprite.scripts = [{ stderr: ["boom"], exitCode: 17 }];
    const result = decodeComputerHostExecResultV1(
      await (await host.handle(request(exec()))).json(),
    );
    expect(result.exitCode).toBe(17);
    expect(Buffer.from(result.stderrBase64, "base64").toString()).toBe("boom");
  });

  test("truncates output at the caller's declared ceiling", async () => {
    const { host, sprite } = provisioned();
    sprite.scripts = [{ stdout: ["a".repeat(50)], exitCode: 0 }];
    const result = decodeComputerHostExecResultV1(
      await (await host.handle(request(exec({ maxOutputBytes: 10 })))).json(),
    );
    expect(Buffer.from(result.stdoutBase64, "base64").toString()).toBe(
      "a".repeat(10),
    );
    expect(result.outputTruncated).toBe(true);
  });

  test("streams NDJSON frames and ends with an exit frame", async () => {
    const { host, sprite } = provisioned();
    sprite.scripts = [
      { stdout: ["one", "two"], stderr: ["warn"], exitCode: 0 },
    ];
    const frames = await readFrames(
      await host.handle(request(exec({ stream: true }))),
    );
    const stdout = frames
      .filter((frame) => frame.type === "stdout")
      .map((frame) => Buffer.from(frame.dataBase64, "base64").toString())
      .join("");
    expect(stdout).toBe("onetwo");
    expect(
      frames.some(
        (frame) =>
          frame.type === "stderr" &&
          Buffer.from(frame.dataBase64, "base64").toString() === "warn",
      ),
    ).toBe(true);
    expect(frames.at(-1)).toEqual({
      type: "exit",
      exitCode: 0,
      outputTruncated: false,
    });
  });

  test("reassembles a streamed answer however the transport splits it", async () => {
    const { host, sprite } = provisioned();
    // One logical line arriving as many tiny chunks: the exact shape that
    // broke the SDK's HTTP exec, and which the NDJSON framing must survive.
    sprite.scripts = [
      { stdout: "hello world".split("").map((letter) => letter), exitCode: 0 },
    ];
    const frames = await readFrames(
      await host.handle(request(exec({ stream: true }))),
    );
    const stdout = frames
      .filter((frame) => frame.type === "stdout")
      .map((frame) => Buffer.from(frame.dataBase64, "base64").toString())
      .join("");
    expect(stdout).toBe("hello world");
  });

  test("a streamed failure ends with an error frame, not a broken stream", async () => {
    const { host, sprite } = provisioned();
    sprite.scripts = [{ error: "websocket closed" }];
    const frames = await readFrames(
      await host.handle(request(exec({ stream: true }))),
    );
    expect(frames.at(-1)).toMatchObject({
      type: "error",
      code: "provider-unavailable",
      retryable: true,
    });
  });

  test("an aborted request terminates the command on the Sprite", async () => {
    const { host, sprite } = provisioned();
    sprite.scripts = [{ hang: true, killedExitCode: 143 }];
    const controller = new AbortController();
    const pending = host.handle(request(exec()), controller.signal);
    await Bun.sleep(10);
    controller.abort();
    const response = await pending;
    expect(response.status).toBe(499);
    expect(decodeComputerHostProblemV1(await response.json()).code).toBe(
      "aborted",
    );
    expect(sprite.commands.at(-1)?.signals).toContain("SIGTERM");
  });

  test("a command that outruns its timeout is terminated and reported", async () => {
    const { host, sprite } = provisioned();
    sprite.scripts = [{ hang: true }];
    const response = await host.handle(request(exec({ timeoutMs: 20 })));
    expect(response.status).toBe(504);
    expect(decodeComputerHostProblemV1(await response.json()).code).toBe(
      "timeout",
    );
    expect(sprite.commands.at(-1)?.signals).toContain("SIGTERM");
  });
});

describe("cancellation", () => {
  test("cancels an in-flight effect by its identifier", async () => {
    const { host, sprite } = provisioned();
    sprite.scripts = [{ hang: true }];
    const pending = host.handle(request(exec({ timeoutMs: 30_000 })));
    await Bun.sleep(10);
    const cancelled = decodeComputerHostCancelResultV1(
      await (
        await host.handle(request({ kind: "cancel" }, { effectId: "effect-1" }))
      ).json(),
    );
    expect(cancelled.cancelled).toBe(true);
    expect((await pending).status).toBe(499);
  });

  test("cancels a streaming exec while its stream is still open", async () => {
    // A streaming exec answers the moment the stream opens, so its effect is
    // still in flight after `handle` has returned. The live test found this:
    // releasing the slot on return made every mid-stream cancel a no-op.
    const { host, sprite } = provisioned();
    sprite.scripts = [{ hang: true }];
    const streamed = host.handle(
      request(exec({ stream: true, timeoutMs: 30_000 }), {
        effectId: "streaming-1",
      }),
    );
    const response = await streamed;
    await Bun.sleep(10);
    const cancelled = decodeComputerHostCancelResultV1(
      await (
        await host.handle(
          request({ kind: "cancel" }, { effectId: "streaming-1" }),
        )
      ).json(),
    );
    expect(cancelled.cancelled).toBe(true);
    const frames = await readFrames(response);
    expect(frames.at(-1)).toMatchObject({ type: "error", code: "aborted" });
    expect(sprite.commands.at(-1)?.signals).toContain("SIGTERM");
  });

  test("a cancel that arrives before the command starts still stops it", async () => {
    const { host } = provisioned();
    const result = decodeComputerHostCancelResultV1(
      await (
        await host.handle(request({ kind: "cancel" }, { effectId: "effect-9" }))
      ).json(),
    );
    expect(result.cancelled).toBe(false);
  });

  test("answers a cancel for an effect it does not hold", async () => {
    const { host } = provisioned();
    const result = decodeComputerHostCancelResultV1(
      await (
        await host.handle(request({ kind: "cancel" }, { effectId: "effect-9" }))
      ).json(),
    );
    expect(result.cancelled).toBe(false);
  });
});

describe("load shedding", () => {
  test("one User cannot exceed its own ceiling", async () => {
    const client = new FakeSpritesClient();
    const host = hostWith(client, { perContainer: 32, perUser: 1 });
    const name = host.spriteNameFor("user-1");
    await client.createSprite(name);
    const sprite = client.sprites.get(name)!;
    sprite.files.set(COMPUTER_HOST_STATE_PATH, {
      bytes: Buffer.from(JSON.stringify({ version: 1, generation: 1 })),
      mode: 0o600,
      mtime: new Date(),
    });
    sprite.scripts = [{ hang: true }];
    const first = host.handle(
      request(exec({ timeoutMs: 30_000 }), { effectId: "e-1" }),
    );
    await Bun.sleep(20);
    const second = await host.handle(
      request(exec({ timeoutMs: 30_000 }), { effectId: "e-2" }),
    );
    expect(second.status).toBe(429);
    const problem = decodeComputerHostProblemV1(await second.json());
    expect(problem.code).toBe("limit-exceeded");
    expect(problem.retryable).toBe(true);
    await host.handle(request({ kind: "cancel" }, { effectId: "e-1" }));
    await first;
  });

  test("the container's own ceiling refuses a second User too", async () => {
    const client = new FakeSpritesClient();
    const host = hostWith(client, { perContainer: 1, perUser: 4 });
    for (const userId of ["user-1", "user-2"]) {
      const name = host.spriteNameFor(userId);
      await client.createSprite(name);
      const sprite = client.sprites.get(name)!;
      sprite.files.set(COMPUTER_HOST_STATE_PATH, {
        bytes: Buffer.from(JSON.stringify({ version: 1, generation: 1 })),
        mode: 0o600,
        mtime: new Date(),
      });
      sprite.scripts = [{ hang: true }];
    }
    const first = host.handle(
      request(exec({ timeoutMs: 30_000 }), { effectId: "e-1" }),
    );
    await Bun.sleep(20);
    const second = await host.handle(
      request(exec({ timeoutMs: 30_000 }), {
        effectId: "e-2",
        identity: { userId: "user-2" },
      }),
    );
    expect(second.status).toBe(429);
    await host.handle(request({ kind: "cancel" }, { effectId: "e-1" }));
    await first;
  });
});

describe("files", () => {
  test("round-trips bytes through the filesystem API, never a shell", async () => {
    const { host, sprite } = provisioned();
    const before = sprite.commands.length;
    const written = await host.handle(
      request({
        kind: "file/write",
        path: "/home/box/agent-data/notes.md",
        bytesBase64: Buffer.from("hello memory").toString("base64"),
        mode: 0o600,
      }),
    );
    expect(written.status).toBe(200);
    const read = decodeComputerHostFileReadResultV1(
      await (
        await host.handle(
          request({
            kind: "file/read",
            path: "/home/box/agent-data/notes.md",
          }),
        )
      ).json(),
    );
    expect(Buffer.from(read.bytesBase64, "base64").toString()).toBe(
      "hello memory",
    );
    expect(read.entry.mode).toBe(0o600);
    expect(read.entry.kind).toBe("file");
    expect(sprite.commands.length).toBe(before);
  });

  test("reads a file that is not there as not-found", async () => {
    const { host } = provisioned();
    const response = await host.handle(
      request({ kind: "file/read", path: "/home/box/missing.md" }),
    );
    expect(response.status).toBe(404);
    expect(decodeComputerHostProblemV1(await response.json()).code).toBe(
      "not-found",
    );
  });

  test("lists a directory", async () => {
    const { host } = provisioned();
    for (const name of ["a.md", "b.md"]) {
      await host.handle(
        request({
          kind: "file/write",
          path: `/home/box/agent-data/${name}`,
          bytesBase64: "",
        }),
      );
    }
    const listed = decodeComputerHostFileListResultV1(
      await (
        await host.handle(
          request({
            kind: "file/list",
            path: "/home/box/agent-data",
            recursive: false,
          }),
        )
      ).json(),
    );
    expect(listed.entries.map((entry) => entry.path)).toContain(
      "/home/box/agent-data/a.md",
    );
    expect(listed.truncated).toBe(false);
  });

  test("deleting a file that is not there is reported, not thrown", async () => {
    const { host } = provisioned();
    const response = await host.handle(
      request({
        kind: "file/delete",
        path: "/home/box/gone.md",
        recursive: false,
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ deleted: false });
  });
});

describe("control", () => {
  test("acquires a lease through the on-Sprite control script", async () => {
    const { host, sprite } = provisioned();
    const result = decodeComputerHostControlResultV1(
      await (
        await host.handle(
          request({
            kind: "control",
            action: "acquire",
            ownerId: "owner-1",
            maxAgeSeconds: 90,
          }),
        )
      ).json(),
    );
    expect(result.action).toBe("acquire");
    expect(result.expiresAt).toBe("2026-08-31T00:01:30.000Z");
    expect(sprite.commands.at(-1)?.stdin).toContain(CONTROL_SCRIPT);
    expect(sprite.commands.at(-1)?.stdin).toContain("'owner-1'");
  });

  test("a lease held by a human is a declared conflict", async () => {
    const { host, sprite } = provisioned();
    sprite.scripts = [
      {
        stderr: ["This agent's computer is already under human control"],
        exitCode: 73,
      },
    ];
    const response = await host.handle(
      request({
        kind: "control",
        action: "acquire",
        ownerId: "owner-2",
        maxAgeSeconds: 90,
      }),
    );
    expect(response.status).toBe(409);
    expect(decodeComputerHostProblemV1(await response.json()).code).toBe(
      "human-control-active",
    );
  });

  test("a release carries no expiry", async () => {
    const { host } = provisioned();
    const result = decodeComputerHostControlResultV1(
      await (
        await host.handle(
          request({
            kind: "control",
            action: "release",
            ownerId: "owner-1",
            maxAgeSeconds: 90,
          }),
        )
      ).json(),
    );
    expect(result.expiresAt).toBeUndefined();
  });
});

describe("viewer", () => {
  test("builds a token-routed noVNC URL from on-Sprite material", async () => {
    const { host, sprite } = provisioned();
    const botKey = `bot-1-${digest("bot-1").slice(0, 12)}`;
    for (const [name, value] of [
      ["viewer-token", "opaque-token\n"],
      ["vnc-password", "secret\n"],
    ]) {
      sprite.files.set(`/home/box/.frockbot/bots/${botKey}/${name}`, {
        bytes: Buffer.from(value!),
        mode: 0o600,
        mtime: new Date(),
      });
    }
    const response = await host.handle(
      request({ kind: "viewer", action: "open" }),
    );
    const body = (await response.json()) as {
      session?: { id: string; url: string };
    };
    expect(body.session?.id).toBe("opaque-token");
    expect(body.session?.url).toContain("vnc.html");
    expect(body.session?.url).toContain("websockify%3Ftoken%3Dopaque-token");
  });

  test("revoking removes the token from the gateway's file", async () => {
    const { host, sprite } = provisioned();
    await host.handle(
      request({ kind: "viewer", action: "revoke", sessionId: "opaque-token" }),
    );
    expect(sprite.commands.at(-1)?.stdin).toContain(`${RUNTIME_ROOT}/tokens`);
    expect(sprite.commands.at(-1)?.stdin).toContain("'opaque-token'");
  });
});

describe("services", () => {
  test("reattaches a declared service", async () => {
    const { host, sprite } = provisioned();
    sprite.services.set(WORKSPACE_SYNC_SERVICE, "running");
    const result = decodeComputerHostServiceResultV1(
      await (
        await host.handle(
          request({ kind: "service", name: WORKSPACE_SYNC_SERVICE }),
        )
      ).json(),
    );
    expect(result.status).toBe("running");
  });

  test("reports a declared service that will not start as unavailable", async () => {
    const { host } = provisioned();
    const result = decodeComputerHostServiceResultV1(
      await (
        await host.handle(request({ kind: "service", name: DESKTOP_SERVICE }))
      ).json(),
    );
    expect(result.status).toBe("unavailable");
  });

  test("refuses a service the Computer provider does not declare", async () => {
    const { host } = provisioned();
    const response = await host.handle(
      request({ kind: "service", name: "cryptominer" }),
    );
    expect(response.status).toBe(400);
    expect(
      decodeComputerHostProblemV1(await response.json()).message,
    ).toContain("not a Computer-provider-declared service");
  });
});

describe("the decoder in front of the host", () => {
  test("an inbound HTTP request reaches the host through the shared decoder", async () => {
    const { host } = provisioned();
    const decoded = await decodeComputerHostHttpRequestV1(
      new Request(`http://computer-host.internal${COMPUTER_HOST_ROUTES.exec}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: 1,
          effectId: "effect-1",
          identity: { userId: "user-1" },
          tenant: { botId: "bot-1" },
          credentialRef: "sprites:user:user-1",
          script: "printf ok",
          timeoutMs: 1_000,
          maxOutputBytes: 1_024,
          stream: false,
        }),
      }),
    );
    if (!decoded.ok) throw new Error("expected a decoded request");
    const result = decodeComputerHostExecResultV1(
      await (await host.handle(decoded.value)).json(),
    );
    expect(result.exitCode).toBe(0);
  });
});
