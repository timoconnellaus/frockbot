import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  utimes,
  writeFile as writeLocalFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  COMPUTER_HOST_ROUTES,
  ComputerHostExecFrameReaderV1,
  ComputerHostOpenFrameReaderV1,
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
  type ComputerHostOpenFrameV1,
  type ComputerHostOperationV1,
  type ComputerHostRequestV1,
} from "@frockbot/computer-host-protocol";
import {
  BOTS_ROOT,
  BROWSER_SERVICE,
  CHROME_PROFILE,
  COMPUTER_DISPLAY,
  CONTROL_SCRIPT,
  controlScript,
  DESKTOP_GUI_LEASE_KEY,
  DESKTOP_SERVICE,
  DESKTOP_SLOTS,
  DESKTOP_TENANT_SERVICE_PREFIX,
  desktopServiceNameV1,
  ENSURE_AGENT_SCRIPT,
  ENSURE_WINDOW_SCRIPT,
  FOCUS_WINDOW_SCRIPT,
  NO_SLOTS_MARKER,
  PROVISION_DIGEST,
  PROVISION_MARKERS,
  PROVISION_PHASES,
  PROVISION_RUNNER_PREFIX,
  PROVISION_SCRIPT,
  provisionScript,
  RUNTIME_ROOT,
  runtimeDocumentDigestV1,
  SCREEN_SERVICE,
  UPDATE_PHASES,
  viewServiceNameV1,
  WORKSPACE_SYNC_SERVICE,
} from "@frockbot/computer-host-runtime";
import {
  ComputerHost,
  COMPUTER_HOST_STATE_PATH,
  computerHostExecScriptV1,
  readProvisionObservation,
} from "./computer.ts";
import {
  FakeApiError,
  FakeSprite,
  FakeSpritesClient,
  type ScriptedCommand,
} from "./fake-sprites.ts";

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
  kind: "provision" | "update" = "provision",
): ScriptedCommand {
  const lines = [`${PROVISION_RUNNER_PREFIX}${runner}\n`];
  if (phase) {
    lines.push(
      `${JSON.stringify({
        version: 1,
        kind,
        documentDigest: runtimeDocumentDigestV1(),
        index: phase.index,
        total:
          kind === "update" ? UPDATE_PHASES.length : PROVISION_PHASES.length,
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

const updatingRuntime = {
  index: 1,
  name: "runtime",
  label: UPDATE_PHASES[0]!.label,
  status: "running",
} as const;

const updateReady = {
  index: UPDATE_PHASES.length,
  name: "ready",
  label: "the Computer update is complete",
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
  writeFile(sprite, PROVISION_DIGEST, `${runtimeDocumentDigestV1()}\n`);
  writeFile(
    sprite,
    `/home/box/.frockbot/bots/bot-1-${digest("bot-1").slice(0, 12)}/slot`,
    "3\n",
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

async function readOpenFrames(
  response: Response,
): Promise<ComputerHostOpenFrameV1[]> {
  const reader = new ComputerHostOpenFrameReaderV1();
  const frames: ComputerHostOpenFrameV1[] = [];
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
  test("streams provisioning phases and ends with the open result", async () => {
    const client = new FakeSpritesClient();
    const host = hostWith(client);
    client.onCreate = (sprite) => {
      sprite.scripts = [
        report("running", installing),
        report("running", installing),
        report("stopped", ready),
      ];
    };

    const response = await host.handle(request({ kind: "open", stream: true }));
    expect(response.headers.get("content-type")).toContain(
      "application/x-ndjson",
    );
    const frames = await readOpenFrames(response);

    expect(
      frames
        .filter((frame) => frame.type === "progress")
        .map((frame) => frame.progress.label),
    ).toEqual(["installing the desktop packages", "the Computer is ready"]);
    expect(frames.at(-1)).toMatchObject({
      type: "result",
      result: {
        effectId: "effect-1",
        provisioning: { status: "complete", index: PROVISION_PHASES.length },
      },
    });
    expect(host.inFlightCount).toBe(0);
  });

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
    const first = client
      .only()
      .commands.find((command) => command.stdin.includes("setsid nohup"));
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

    const commands = client.only().commands;
    const launch = commands.find((command) =>
      command.stdin.includes("setsid nohup"),
    );
    expect(launch?.stdin).toContain("setsid nohup");
    expect(launch?.stdin).toContain(PROVISION_SCRIPT);
    // Every later command is short. None of them carries the document, and
    // none of them starts anything, so none of them can be quiet for 45 s.
    const polls = commands
      .filter((command) => command.stdin.includes(PROVISION_RUNNER_PREFIX))
      .filter((command) => command !== launch);
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
    expect(
      client
        .only()
        .commands.find((command) => command.stdin.includes("setsid nohup"))
        ?.stdin,
    ).toContain(Buffer.from(provisionScript).toString("base64"));
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
    expect(failure.message).toContain(
      `installing the desktop packages (2/${PROVISION_PHASES.length})`,
    );
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
    expect(failure.message).toContain(
      `installing the desktop packages (2/${PROVISION_PHASES.length})`,
    );
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
    ).toContain(
      `installing the desktop packages (2/${PROVISION_PHASES.length})`,
    );
  });

  test("attaches the tenant through the ensure script and reports its display", async () => {
    const { host, sprite } = provisioned();
    const response = await host.handle(request({ kind: "open" }));
    const result = decodeComputerHostOpenResultV1(await response.json());
    expect(result.generation).toBe(4);
    // One screen per Computer (ADR 0030): every Bot's window is on it, and a
    // slot is a rectangle of it rather than a display number of its own.
    expect(result.display).toBe(COMPUTER_DISPLAY);
    expect(result.directory).toBe(
      `/home/box/agent-data/agents/bot-1-${digest("bot-1").slice(0, 12)}`,
    );
    expect(
      sprite.commands.some((command) =>
        command.stdin.includes(ENSURE_AGENT_SCRIPT),
      ),
    ).toBe(true);
  });

  test("starts one screen, one browser, and this tenant's own viewer", async () => {
    // The defect this is the fix for: every slot got its own Xvfb and its own
    // browser launch against the one shared profile. Chromium's singleton lock
    // is per profile, so only the first launch ever became a browser; the rest
    // printed "Opening in existing browser session", exited, and left their
    // Bots black screens with dead CDP ports.
    const { host, sprite } = provisioned();
    const botKey = `bot-1-${digest("bot-1").slice(0, 12)}`;
    const view = viewServiceNameV1(botKey);

    const response = await host.handle(request({ kind: "open" }));

    expect(decodeComputerHostOpenResultV1(await response.json()).display).toBe(
      COMPUTER_DISPLAY,
    );
    expect(sprite.serviceConfigs.get(SCREEN_SERVICE)).toEqual({
      cmd: `${RUNTIME_ROOT}/start-screen.sh`,
    });
    expect(sprite.serviceConfigs.get(BROWSER_SERVICE)).toEqual({
      cmd: `${RUNTIME_ROOT}/start-browser.sh`,
    });
    expect(sprite.serviceConfigs.get(view)).toEqual({
      cmd: `${RUNTIME_ROOT}/start-view.sh`,
      args: [botKey],
    });
    // One browser for the Computer, and one Xvfb: never one of either per Bot.
    expect(
      sprite.serviceCreates.filter((name) =>
        name.startsWith(DESKTOP_TENANT_SERVICE_PREFIX),
      ),
    ).toEqual([]);
    expect(
      sprite.commands
        .at(-1)
        ?.stdin.includes(`${ENSURE_WINDOW_SCRIPT} '${botKey}'`),
    ).toBe(true);
  });

  test("gives a second Bot its own window without a second browser", async () => {
    // The requirement the shared browser exists for: a login Bot A makes is a
    // login Bot B has. That means one profile, and one profile means one
    // browser process — so Bot B's open declares a viewer and creates a window,
    // and declares neither a screen nor a browser again.
    const { host, sprite } = provisioned();
    const botB = `bot-2-${digest("bot-2").slice(0, 12)}`;
    writeFile(sprite, `${BOTS_ROOT}/${botB}/slot`, "1\n");

    await host.handle(request({ kind: "open" }));
    const before = sprite.serviceCreates.length;
    const response = await host.handle(
      request(
        { kind: "open" },
        { effectId: "open-2", tenant: { botId: "bot-2" } },
      ),
    );

    expect(decodeComputerHostOpenResultV1(await response.json()).display).toBe(
      COMPUTER_DISPLAY,
    );
    expect(sprite.serviceCreates.slice(before)).toEqual([
      viewServiceNameV1(botB),
    ]);
  });

  test("leaves a screen, a browser, and a viewer that are already up alone", async () => {
    // `createService` is a create-*or-update*: declaring the screen on every
    // open would restart Xvfb, and with it the browser and every window on it.
    const { host, sprite } = provisioned();
    const view = viewServiceNameV1(`bot-1-${digest("bot-1").slice(0, 12)}`);

    await host.handle(request({ kind: "open" }));
    await host.handle(request({ kind: "open" }, { effectId: "open-2" }));

    for (const name of [SCREEN_SERVICE, BROWSER_SERVICE, view]) {
      expect(
        sprite.serviceCreates.filter((candidate) => candidate === name),
      ).toHaveLength(1);
    }
  });

  test("retires the superseded per-slot desktop services, and never the profile", async () => {
    // The migration (ADR 0030). An existing Computer carries one
    // `frockbot-desktop-<botKey>` per tenant, and one of their browsers is
    // holding the shared profile's singleton lock right now: the new browser
    // service cannot take the profile until they are stopped. What must survive
    // is the profile itself — it is the User's login state.
    const { host, sprite } = provisioned();
    const legacy = [
      desktopServiceNameV1(`bot-1-${digest("bot-1").slice(0, 12)}`),
      desktopServiceNameV1("another-tenant-0123456789ab"),
    ];
    for (const name of legacy) {
      await sprite.createService(name, {
        cmd: `${RUNTIME_ROOT}/start-desktop.sh`,
        args: ["whoever"],
      });
    }
    writeFile(sprite, `${CHROME_PROFILE}/Default/Cookies`, "a login");

    await host.handle(request({ kind: "open" }));

    expect(sprite.serviceStops).toEqual(legacy);
    expect(sprite.serviceDeletes).toEqual(legacy);
    for (const name of legacy) expect(sprite.services.has(name)).toBe(false);
    expect(sprite.services.get(BROWSER_SERVICE)).toBe("running");
    expect(
      sprite.files.get(`${CHROME_PROFILE}/Default/Cookies`)?.bytes.toString(),
    ).toBe("a login");
  });

  test("the migration runs once per Computer and survives a platform that refuses it", async () => {
    // Defensive and idempotent: a Computer with nothing to retire does nothing,
    // a stop or delete that fails does not cost the Bot its Computer, and a
    // second open does not walk the service list again.
    const { host, sprite } = provisioned();
    const legacy = desktopServiceNameV1("stuck-0123456789ab");
    await sprite.createService(legacy, {
      cmd: `${RUNTIME_ROOT}/start-desktop.sh`,
      args: ["stuck"],
    });
    sprite.onServiceOperation = (operation) => {
      if (operation === "stop") throw new FakeApiError(500, "will not stop");
    };

    const first = await host.handle(request({ kind: "open" }));
    const deletes = sprite.serviceDeletes.length;
    await host.handle(request({ kind: "open" }, { effectId: "open-2" }));

    expect(decodeComputerHostOpenResultV1(await first.json()).display).toBe(
      COMPUTER_DISPLAY,
    );
    expect(sprite.serviceDeletes).toEqual([legacy]);
    expect(sprite.serviceDeletes).toHaveLength(deletes);
  });

  test("reports no display when the tenant's screen will not start", async () => {
    // A display is optional, and a screen that failed to start is absent —
    // never a display the viewer would open onto and find nothing.
    const { host, sprite } = provisioned();
    sprite.onCreateService = (name) => {
      if (name === SCREEN_SERVICE) {
        throw new FakeApiError(500, "no capacity for another display");
      }
    };

    const response = await host.handle(request({ kind: "open" }));

    expect(response.status).toBe(200);
    expect(
      decodeComputerHostOpenResultV1(await response.json()).display,
    ).toBeUndefined();
  });

  test("reports no display when the tenant could not be given a window", async () => {
    const { host, sprite } = provisioned();
    sprite.windowExitCode = 69;

    const response = await host.handle(request({ kind: "open" }));

    expect(response.status).toBe(200);
    expect(
      decodeComputerHostOpenResultV1(await response.json()).display,
    ).toBeUndefined();
  });

  test("refuses a slot from the superseded hundred-display layout", async () => {
    // A slot past the edge of the one screen is a window nobody can see and a
    // clip rectangle x11vnc refuses. Only a Computer that allocated slots under
    // the old layout can carry one.
    const { host, sprite } = provisioned();
    writeFile(
      sprite,
      `${BOTS_ROOT}/bot-1-${digest("bot-1").slice(0, 12)}/slot`,
      `${DESKTOP_SLOTS}\n`,
    );

    const response = await host.handle(request({ kind: "open" }));

    expect(
      decodeComputerHostOpenResultV1(await response.json()).display,
    ).toBeUndefined();
    expect(sprite.serviceCreates).toEqual([]);
  });

  test("does not turn an absent slot marker value into display zero", async () => {
    const { host, sprite } = provisioned();
    sprite.files.delete(
      `${BOTS_ROOT}/bot-1-${digest("bot-1").slice(0, 12)}/slot`,
    );

    const response = await host.handle(request({ kind: "open" }));

    expect(
      decodeComputerHostOpenResultV1(await response.json()).display,
    ).toBeUndefined();
    expect(sprite.serviceCreates).toHaveLength(0);
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

  test("adopts a Computer with the matching digest without an update", async () => {
    const { host, sprite } = provisioned();

    const response = await host.handle(request({ kind: "open" }));

    expect(response.status).toBe(200);
    expect(
      decodeComputerHostOpenResultV1(await response.json()).provisioning,
    ).toBeUndefined();
    expect(
      sprite.commands.some((command) =>
        command.stdin.includes(`${PROVISION_SCRIPT} update`),
      ),
    ).toBe(false);
  });

  test("updates a mismatched runtime in place without apt and then hands back the same Computer", async () => {
    const { host, sprite } = provisioned();
    writeFile(sprite, PROVISION_DIGEST, "stale\n");
    let stateAtLaunch: unknown;
    const launch = report("running", updatingRuntime, "update");
    launch.after = () => {
      stateAtLaunch = JSON.parse(
        sprite.files.get(COMPUTER_HOST_STATE_PATH)!.bytes.toString(),
      );
    };
    sprite.scripts = [launch, report("stopped", updateReady, "update")];

    const response = await host.handle(request({ kind: "open" }));
    const opened = decodeComputerHostOpenResultV1(await response.json());

    expect(response.status).toBe(200);
    expect(opened.spriteName).toBe(sprite.name);
    expect(opened.generation).toBe(4);
    expect(opened.provisioning).toMatchObject({
      kind: "update",
      status: "complete",
    });
    expect(sprite.files.get(PROVISION_DIGEST)?.bytes.toString().trim()).toBe(
      runtimeDocumentDigestV1(),
    );
    const update = sprite.commands.find((command) =>
      command.stdin.includes(`${PROVISION_SCRIPT} update`),
    );
    expect(update?.stdin).toContain("setsid nohup");
    expect(update?.stdin).not.toContain("apt-get");
    expect(stateAtLaunch).toMatchObject({
      update: { status: "started", digest: runtimeDocumentDigestV1() },
    });
    expect(
      JSON.parse(sprite.files.get(COMPUTER_HOST_STATE_PATH)!.bytes.toString()),
    ).toEqual({ version: 1, generation: 4 });
    expect(
      sprite.serviceCreates.filter((name) => name === DESKTOP_SERVICE),
    ).toHaveLength(1);
    expect(sprite.serviceConfigs.get(DESKTOP_SERVICE)).toEqual({
      cmd: `${RUNTIME_ROOT}/start-gateway.sh`,
      httpPort: 6080,
    });
    // The defect this closes: the gateway's *definition* never changes — an
    // update rewrites the contents of `start-gateway.sh`, not the service that
    // runs it — so re-declaring it is a no-op the platform correctly ignores.
    // A Computer went on serving noVNC's stock page for days that way. Picking
    // up a rewritten launcher takes a restart.
    expect(sprite.serviceRestarts).toEqual([DESKTOP_SERVICE]);
  });

  test("a gateway that will not restart does not fail the open", async () => {
    // A Computer with no viewer is worth reporting through box-doctor; it is
    // not worth refusing the exec and file surfaces over.
    const { host, sprite } = provisioned();
    writeFile(sprite, PROVISION_DIGEST, "stale\n");
    sprite.scripts = [
      report("running", updatingRuntime, "update"),
      report("stopped", updateReady, "update"),
    ];
    sprite.onServiceOperation = (operation, name) => {
      if (operation === "restart" && name === DESKTOP_SERVICE) {
        throw new FakeApiError(500, "the gateway would not come back");
      }
    };

    const response = await host.handle(request({ kind: "open" }));

    expect(response.status).toBe(200);
    expect(sprite.services.get(DESKTOP_SERVICE)).toBe("running");
  });

  test("provisioning a Computer starts the gateway rather than restarting it", async () => {
    // Nothing is running yet, so the declaration is the start. A restart here
    // would be a second process launch on a Computer that has had none.
    const client = new FakeSpritesClient();
    const host = hostWith(client);
    client.onCreate = (sprite) => {
      sprite.scripts = [
        report("running", installing),
        report("stopped", ready),
      ];
    };

    await host.handle(request({ kind: "open" }));

    expect(client.only().serviceCreates).toContain(DESKTOP_SERVICE);
    expect(client.only().serviceRestarts).toEqual([]);
  });

  test("reconciles the gateway before clearing a completed runtime-update intent", async () => {
    const { host, sprite } = provisioned();
    writeFile(
      sprite,
      COMPUTER_HOST_STATE_PATH,
      JSON.stringify({
        version: 1,
        generation: 4,
        update: {
          status: "started",
          digest: runtimeDocumentDigestV1(),
          recordedAt: "2026-08-31T00:00:00.000Z",
        },
      }),
    );

    const response = await host.handle(request({ kind: "open" }));

    expect(response.status).toBe(200);
    expect(
      sprite.serviceCreates.filter((name) => name === DESKTOP_SERVICE),
    ).toHaveLength(1);
    // The reconciliation replays the update's last effect, and that effect is
    // the restart: the definition it re-declares has not changed.
    expect(sprite.serviceRestarts).toEqual([DESKTOP_SERVICE]);
    expect(
      JSON.parse(sprite.files.get(COMPUTER_HOST_STATE_PATH)!.bytes.toString()),
    ).toEqual({ version: 1, generation: 4 });
  });

  test("a missing digest is stale exactly once", async () => {
    const { host, sprite } = provisioned();
    sprite.files.delete(PROVISION_DIGEST);
    sprite.scripts = [
      report("running", updatingRuntime, "update"),
      report("stopped", updateReady, "update"),
    ];

    expect((await host.handle(request({ kind: "open" }))).status).toBe(200);
    expect(
      (await host.handle(request({ kind: "open" }, { effectId: "open-2" })))
        .status,
    ).toBe(200);

    expect(
      sprite.commands.filter((command) =>
        command.stdin.includes(`${PROVISION_SCRIPT} update`),
      ),
    ).toHaveLength(1);
  });

  test("a fresh human-control lease installs the update but defers the gateway", async () => {
    const { host, sprite } = provisioned();
    writeFile(sprite, PROVISION_DIGEST, "stale\n");
    const lease = `${RUNTIME_ROOT}/bots/another-tenant/human-control`;
    writeFile(sprite, lease, "viewer-1\n");
    sprite.scripts = [
      report("running", updatingRuntime, "update"),
      report("stopped", updateReady, "update"),
    ];
    const declarations = sprite.serviceCreates.filter(
      (name) => name === DESKTOP_SERVICE,
    ).length;

    const response = await host.handle(request({ kind: "open" }));

    // The update phases are file installs and run even under a human lease:
    // deferring them is what left a Computer serving no viewer page.
    expect(response.status).toBe(200);
    expect(
      sprite.commands.some((command) =>
        command.stdin.includes(`${PROVISION_SCRIPT} update`),
      ),
    ).toBe(true);
    // The gateway is the one disruptive step, so it waits for the lease.
    expect(
      sprite.serviceCreates.filter((name) => name === DESKTOP_SERVICE).length,
    ).toBe(declarations);
    expect(
      JSON.parse(sprite.files.get(COMPUTER_HOST_STATE_PATH)!.bytes.toString()),
    ).toMatchObject({
      version: 1,
      generation: 4,
      update: {
        status: "started",
        digest: runtimeDocumentDigestV1(),
      },
    });

    // Once the lease goes stale the next open reconciles the re-declaration
    // and clears the durable intent, without installing anything again.
    sprite.files.get(lease)!.mtime = new Date("2026-08-30T23:58:00.000Z");
    const resumed = await host.handle(
      request({ kind: "open" }, { effectId: "open-after-lease" }),
    );
    expect(resumed.status).toBe(200);
    expect(
      sprite.serviceCreates.filter((name) => name === DESKTOP_SERVICE).length,
    ).toBe(declarations + 1);
    expect(
      JSON.parse(sprite.files.get(COMPUTER_HOST_STATE_PATH)!.bytes.toString()),
    ).toMatchObject({ version: 1, generation: 4 });
  });

  test("a second caller waits its bound then receives computer-updating with the current label", async () => {
    const client = new FakeSpritesClient();
    const host = new ComputerHost({
      client,
      baseSpriteName: "frockbot",
      digest,
      now: () => Date.parse("2026-08-31T00:00:00.000Z"),
      provisionPollMs: 30,
      updateWaitMs: 5,
    });
    const sprite = new FakeSprite(host.spriteNameFor("user-1"));
    client.sprites.set(sprite.name, sprite);
    writeFile(
      sprite,
      COMPUTER_HOST_STATE_PATH,
      JSON.stringify({ version: 1, generation: 4 }),
    );
    writeFile(sprite, PROVISION_DIGEST, "stale\n");
    writeFile(
      sprite,
      `/home/box/.frockbot/bots/bot-1-${digest("bot-1").slice(0, 12)}/slot`,
      "3\n",
    );
    sprite.scripts = [
      report("running", updatingRuntime, "update"),
      report("stopped", updateReady, "update"),
    ];

    const first = host.handle(
      request({ kind: "open" }, { effectId: "open-1" }),
    );
    while (
      !sprite.commands.some((command) =>
        command.stdin.includes(`${PROVISION_SCRIPT} update`),
      )
    ) {
      await Bun.sleep(1);
    }
    const second = await host.handle(
      request({ kind: "open" }, { effectId: "open-2" }),
    );

    expect(second.status).toBe(409);
    const failure = decodeComputerHostProblemV1(await second.json());
    expect(failure).toMatchObject({
      code: "computer-updating",
      retryable: true,
      message: UPDATE_PHASES[0]!.label,
    });
    expect((await first).status).toBe(200);
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

  test("looks the Sprite up once, however many operations a Turn makes", async () => {
    // Measured against production: one tool call fanned out to 14 lookups
    // costing ~1.35s of an 11.7s call, every one of them answering with what
    // the first already knew. A handle is a name bound to a client, so the
    // repeat buys nothing.
    const { host, client, sprite } = provisioned();
    sprite.scripts = [
      { stdout: ["one"], exitCode: 0 },
      { stdout: ["two"], exitCode: 0 },
      { stdout: ["three"], exitCode: 0 },
    ];

    await host.handle(request(exec({ script: "printf one" })));
    await host.handle(request(exec({ script: "printf two" })));
    await host.handle(request(exec({ script: "printf three" })));

    expect(client.lookups.length).toBe(1);
  });

  test("asks again after a lookup fails, rather than remembering the failure", async () => {
    // A cache that keeps a rejection turns one bad moment at the Sprites API
    // into a Computer that stays broken until the container restarts.
    const { host, client, sprite } = provisioned();
    sprite.scripts = [{ stdout: ["after"], exitCode: 0 }];
    const lookup = client.getSprite.bind(client);
    let failNext = true;
    client.getSprite = async (name: string) => {
      if (failNext) {
        failNext = false;
        client.lookups.push(name);
        throw new FakeApiError(500, "sprites is having a moment");
      }
      return lookup(name);
    };

    await host.handle(request(exec({ script: "true" }))).catch(() => undefined);
    const response = await host.handle(
      request(exec({ script: "printf after" })),
    );

    // The second attempt looked again and succeeded.
    expect(client.lookups.length).toBeGreaterThan(1);
    const result = decodeComputerHostExecResultV1(await response.json());
    expect(result.exitCode).toBe(0);
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
    const written = await host.handle(
      request({
        kind: "file/write",
        path: "/home/box/agent-data/notes.md",
        bytesBase64: Buffer.from("hello memory").toString("base64"),
        mode: 0o600,
      }),
    );
    expect(written.status).toBe(200);
    const before = sprite.commands.length;
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
  test("a human acquire uses the User-wide desktop lease key", async () => {
    const { host, sprite } = provisioned();
    const result = decodeComputerHostControlResultV1(
      await (
        await host.handle(
          request({
            kind: "control",
            action: "acquire",
            ownerId: "owner-1",
            maxAgeSeconds: 90,
            scope: "desktop-gui",
          }),
        )
      ).json(),
    );
    expect(result.action).toBe("acquire");
    expect(result.expiresAt).toBe("2026-08-31T00:01:30.000Z");
    expect(
      sprite.commands.some((command) => command.stdin.includes(CONTROL_SCRIPT)),
    ).toBe(true);
    // Every Bot's window is on one screen now (ADR 0030), so a takeover that
    // raised nothing hands the human whichever window Chromium last focused.
    expect(sprite.commands.at(-1)?.stdin).toContain(FOCUS_WINDOW_SCRIPT);
    const controlCommand = sprite.commands.find((command) =>
      command.stdin.includes(CONTROL_SCRIPT),
    );
    expect(controlCommand?.stdin).toContain(`'${DESKTOP_GUI_LEASE_KEY}'`);
    expect(controlCommand?.stdin).toContain("'owner-1'");
  });

  test("Bot B's guarded exec is refused by Bot A's User-wide lease until release", async () => {
    const { host, sprite } = provisioned();
    sprite.scripts = [
      { exitCode: 0 },
      {
        stderr: ["This Computer's control lease is held by human-session-a"],
        exitCode: 73,
      },
      { exitCode: 0 },
      { stdout: ["released"], exitCode: 0 },
    ];
    await host.handle(
      request(
        {
          kind: "control",
          action: "acquire",
          ownerId: "human-session-a",
          maxAgeSeconds: 90,
          scope: "desktop-gui",
        },
        { tenant: { botId: "bot-a" } },
      ),
    );
    const botBKey = `bot-b-${digest("bot-b").slice(0, 12)}`;
    const guarded = `${CONTROL_SCRIPT} assert-agent '${botBKey}' '${DESKTOP_GUI_LEASE_KEY}' 'agent-b' 90\nprintf guarded`;
    const refused = decodeComputerHostExecResultV1(
      await (
        await host.handle(
          request(exec({ script: guarded }), {
            tenant: { botId: "bot-b" },
          }),
        )
      ).json(),
    );
    expect(refused.exitCode).toBe(73);
    expect(Buffer.from(refused.stderrBase64, "base64").toString()).toContain(
      "human-session-a",
    );

    await host.handle(
      request(
        {
          kind: "control",
          action: "release",
          ownerId: "human-session-a",
          maxAgeSeconds: 90,
          scope: "desktop-gui",
        },
        { tenant: { botId: "bot-a" } },
      ),
    );
    const released = decodeComputerHostExecResultV1(
      await (
        await host.handle(
          request(exec({ script: guarded }), {
            tenant: { botId: "bot-b" },
          }),
        )
      ).json(),
    );
    expect(released.exitCode).toBe(0);
    expect(Buffer.from(released.stdoutBase64, "base64").toString()).toBe(
      "released",
    );
  });

  test("a stale User-wide lease no longer refuses a guarded command", async () => {
    const directory = await mkdtemp(join(tmpdir(), "frockbot-host-control-"));
    const runtimeRoot = join(directory, "runtime");
    const scriptPath = join(directory, "control.sh");
    const statPath = join(directory, "stat");
    const desktopLeaseRoot = join(runtimeRoot, "bots", DESKTOP_GUI_LEASE_KEY);
    const desktopLease = join(desktopLeaseRoot, "human-control");
    try {
      await mkdir(desktopLeaseRoot, { recursive: true });
      await writeLocalFile(
        scriptPath,
        controlScript.replaceAll(RUNTIME_ROOT, runtimeRoot),
      );
      await writeLocalFile(
        statPath,
        [
          "#!/usr/bin/env bash",
          'if /usr/bin/stat -f %m / >/dev/null 2>&1; then exec /usr/bin/stat -f %m "${@: -1}"; fi',
          'exec /usr/bin/stat -c %Y "${@: -1}"',
          "",
        ].join("\n"),
      );
      await chmod(statPath, 0o700);
      await writeLocalFile(desktopLease, "human-session-stale\n");

      const assert = async () => {
        const child = Bun.spawn(
          [
            "bash",
            scriptPath,
            "--locked",
            "assert-agent",
            "bot-b-key",
            DESKTOP_GUI_LEASE_KEY,
            "agent-b",
            "90",
          ],
          {
            env: {
              ...process.env,
              PATH: `${directory}:${process.env.PATH ?? ""}`,
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const [exitCode, stderr] = await Promise.all([
          child.exited,
          new Response(child.stderr).text(),
        ]);
        return { exitCode, stderr };
      };

      const fresh = await assert();
      expect(fresh.exitCode).toBe(73);
      expect(fresh.stderr).toContain("human-session-stale");
      const expiredAt = new Date(Date.now() - 120_000);
      await utimes(desktopLease, expiredAt, expiredAt);
      expect((await assert()).exitCode).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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
            scope: "desktop-gui",
          }),
        )
      ).json(),
    );
    expect(result.expiresAt).toBeUndefined();
  });
});

describe("viewer", () => {
  test("builds the FrockBot viewer URL in one Sprite round trip", async () => {
    const { client, host, sprite } = provisioned();
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
    await host.handle(request({ kind: "open" }));
    const commandCount = sprite.commands.length;
    const readCount = sprite.fileReads.length;
    const lookupCount = client.lookups.length;
    const response = await host.handle(
      request({ kind: "viewer", action: "open" }),
    );
    const body = (await response.json()) as {
      session?: { id: string; url: string };
    };
    expect(body.session?.id).toBe("opaque-token");
    expect(body.session?.url).toContain("/index.html");
    expect(body.session?.url).toContain("websockify%3Ftoken%3Dopaque-token");
    expect(body.session?.url).toContain("view_only=1");
    expect(sprite.commands.at(-1)?.stdin).toContain(
      `BOT='${BOTS_ROOT}/${botKey}'`,
    );
    expect(sprite.commands.at(-1)?.stdin).toContain('touch "$BOT/last-seen"');
    expect(sprite.commands).toHaveLength(commandCount + 1);
    expect(sprite.fileReads).toHaveLength(readCount);
    expect(client.lookups).toHaveLength(lookupCount);
  });

  test("renewing a known viewer touches last-seen and returns the same session", async () => {
    const { host, sprite } = provisioned();
    const botKey = `bot-1-${digest("bot-1").slice(0, 12)}`;
    for (const [name, value] of [
      ["viewer-token", "opaque-token\n"],
      ["vnc-password", "secret\n"],
    ]) {
      writeFile(sprite, `${BOTS_ROOT}/${botKey}/${name}`, value!);
    }

    const response = await host.handle(
      request({
        kind: "viewer",
        action: "renew",
        sessionId: "opaque-token",
      }),
    );
    const body = (await response.json()) as {
      session?: { id: string; url: string };
    };

    expect(response.status).toBe(200);
    expect(body.session?.id).toBe("opaque-token");
    expect(body.session?.url).toContain("view_only=1");
    expect(sprite.commands.at(-1)?.stdin).toContain(
      `BOT='${BOTS_ROOT}/${botKey}'`,
    );
    expect(sprite.commands.at(-1)?.stdin).toContain('touch "$BOT/last-seen"');
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
