/**
 * An in-memory `ComputerHostV1`.
 *
 * This is the proof that the interface is an interface: everything above the
 * Computer — the Bot's tools, the Durable Object Contribution, the projections
 * — runs against this host unchanged, and there is no Fly in it at all. It is
 * also the fixture this Package's own suites open a Computer with, so a change
 * to the interface breaks one file rather than seven.
 *
 * What it is made of is deliberately boring: a `Map` for the Workspace, a
 * table of scripted `exec` answers, one 1×1 PNG, viewer sessions on an
 * `https://viewer.invalid/…` URL, process records, one doctor report, and
 * leases keyed by scope. It records what it was asked, so a test asserts on
 * the calls rather than on a filesystem.
 *
 * It imports `@frockbot/computer/core` and nothing else from this Package —
 * `scripts/check-computer-host-imports.ts` rule 4 — because a fake that
 * reached into an implementation would be that implementation's double rather
 * than a second host.
 */
import {
  ComputerError,
  computerIdentityKeyV1,
  computerTenantBotIdV1,
  type ComputerAssignment,
  type ComputerIdentityV1,
  type ComputerOperationOptions,
  type ComputerTenantV1,
  type WorkspaceLayoutV1,
} from "@frockbot/computer/core";
import {
  computerSyncSummaryV1,
  type ComputerBackgroundStateV1,
  type ComputerControlLease,
  type ComputerControlRequestV1,
  type ComputerDoctorReportV1,
  type ComputerExecRequest,
  type ComputerExecResult,
  type ComputerHostCapabilitiesV1,
  type ComputerHostSessionV1,
  type ComputerHostV1,
  type ComputerScreenshotV1,
  type ComputerSyncReasonV1,
  type ComputerSyncSummaryV1,
  type ComputerViewerSession,
  type ComputerWorkspace,
} from "@frockbot/computer/core/host";
import type {
  WorkspaceEntryV1,
  WorkspaceGenerationV1,
  WorkspacePathV1,
  WorkspaceRootV1,
  WorkspaceWriterV1,
} from "@frockbot/core/contracts";

const encoder = new TextEncoder();

/**
 * The one durable root this host declares.
 *
 * A single `package-declared` root answers every question the Workspace suites
 * ask — attribution, bounds, round-trip — and a host that declared five would
 * be describing a layout nothing here implements.
 */
export const FAKE_WORKSPACE_LAYOUT: WorkspaceLayoutV1 = {
  schemaVersion: 1,
  home: "/home/box",
  roots: [
    {
      kind: "package-declared",
      scope: "user",
      mountPath: "/home/box/agent-data/user-packages/{package}/{root}",
      access: "read-write",
    },
  ],
};

/** The scratch directory this host exports into every shell. */
export const FAKE_SCRATCH_ROOT = "/tmp/frockbot-scratch";

/** The origin this host's viewer is framed from. */
export const FAKE_VIEWER_ORIGIN = "https://viewer.invalid";

/**
 * A real 1×1 PNG: signature, IHDR, IDAT, IEND. Real bytes rather than a
 * signature and zeroes, because a caller that decodes the image is exactly the
 * caller this host has to be honest with.
 */
export const FAKE_SCREENSHOT_PNG_V1: Uint8Array = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0,
  0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120,
  218, 99, 100, 96, 248, 95, 15, 0, 2, 135, 1, 128, 235, 71, 186, 146, 0, 0, 0,
  0, 73, 69, 78, 68, 174, 66, 96, 130,
]);

/**
 * What this host is.
 *
 * `refuseGuiCommand` is the same *kind* of policy Fly's is — a sentence, not a
 * boundary — and deliberately a different sentence, so a test that asserted
 * one host's words fails against the other rather than passing by coincidence.
 */
export const FAKE_HOST_CAPABILITIES_V1: ComputerHostCapabilitiesV1 = {
  scratchPath: FAKE_SCRATCH_ROOT,
  refuseGuiCommand: (command) =>
    /\b(?:xdotool|wmctrl|import)\b/.test(command)
      ? "This Computer has no GUI shell. Use the Computer's own browser and screenshot tools."
      : undefined,
  desktop: { slots: 2, width: 1280, height: 720 },
  viewerFrameOrigins: [FAKE_VIEWER_ORIGIN],
};

/** An in-memory `ComputerWorkspace` that records every write it admitted. */
export class FakeWorkspace implements ComputerWorkspace {
  readonly layout = FAKE_WORKSPACE_LAYOUT;
  readonly files = new Map<
    string,
    { bytes: Uint8Array; generation: WorkspaceGenerationV1 }
  >();
  readonly deleted: string[] = [];
  readonly reads: WorkspacePathV1[] = [];
  readonly lists: { root: WorkspaceRootV1; prefix?: string }[] = [];
  /**
   * Every write, in order, with the root it named.
   *
   * The file map is keyed by path alone, so it cannot answer *which durable
   * root* a Package wrote to — and that is the question a test about writer
   * attribution has to ask.
   */
  readonly writes: {
    path: WorkspacePathV1;
    bytes: Uint8Array;
    writer: WorkspaceWriterV1;
  }[] = [];
  private sequence = 0;

  private key(path: WorkspacePathV1): string {
    return path.path;
  }

  read(path: WorkspacePathV1) {
    this.reads.push(path);
    const held = this.files.get(this.key(path));
    return Promise.resolve(
      held
        ? {
            status: "ok" as const,
            file: { path, generation: held.generation, bytes: held.bytes },
          }
        : { status: "not-found" as const, reason: "no such file" },
    );
  }

  stat(path: WorkspacePathV1) {
    const held = this.files.get(this.key(path));
    return Promise.resolve(
      held
        ? {
            status: "ok" as const,
            entry: { path, generation: held.generation },
          }
        : { status: "not-found" as const, reason: "no such file" },
    );
  }

  list(request: { root: WorkspaceRootV1; prefix?: string }) {
    this.lists.push(request);
    const entries: WorkspaceEntryV1[] = [...this.files.entries()]
      .filter(([path]) => !request.prefix || path.startsWith(request.prefix))
      .map(([path, held]) => ({
        path: { root: request.root, path },
        generation: held.generation,
      }));
    return Promise.resolve({ status: "ok" as const, entries });
  }

  write(request: {
    path: WorkspacePathV1;
    bytes: Uint8Array;
    writer: WorkspaceWriterV1;
  }) {
    this.sequence += 1;
    this.writes.push(request);
    const generation: WorkspaceGenerationV1 = {
      schemaVersion: 1,
      generationId: `gen-${this.sequence}`,
      // A stand-in digest with the shape the decoders require.
      contentHash: this.sequence.toString(16).padStart(64, "a"),
      size: request.bytes.byteLength,
      writer: request.writer,
      writtenAt: new Date(1_700_000_000_000 + this.sequence).toISOString(),
    };
    this.files.set(this.key(request.path), {
      bytes: request.bytes,
      generation,
    });
    return Promise.resolve({ status: "ok" as const, generation });
  }

  delete(request: { path: WorkspacePathV1 }) {
    const held = this.files.get(this.key(request.path));
    this.deleted.push(request.path.path);
    this.files.delete(this.key(request.path));
    return Promise.resolve(
      held
        ? { status: "ok" as const, generation: held.generation }
        : { status: "not-found" as const, reason: "no such file" },
    );
  }
}

/** How the fake answers one `exec`. Every field has a working default. */
export interface FakeExecAnswerV1 {
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  outputTruncated?: boolean;
  /** Thrown instead of answering, for the failure half of a suite. */
  fail?: Error;
}

/**
 * One scripted `exec` rule.
 *
 * `match` is a substring of the composed command line rather than a regex,
 * because a table a reader can scan is worth more here than one that can
 * express everything.
 */
export interface FakeExecRuleV1 extends FakeExecAnswerV1 {
  match: string;
}

/** One `exec` the host was asked for, in order. */
export interface FakeExecCallV1 {
  botId: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
}

/** One durable-root sync the host was asked for, in order. */
export interface FakeSyncCallV1 {
  botId: string;
  reason: ComputerSyncReasonV1;
}

export interface FakeComputerHostOptionsV1 {
  /** The registered id. Defaults to `fake-computer-host`. */
  id?: string;
  capabilities?: ComputerHostCapabilitiesV1;
  /** Answers for the commands a suite scripts; first match wins. */
  exec?: readonly FakeExecRuleV1[];
  /** The answer for a command no rule names. */
  execDefault?: FakeExecAnswerV1;
  /** The bytes a capture answers with. Defaults to the 1×1 PNG. */
  screenshot?: Uint8Array;
  doctor?: ComputerDoctorReportV1;
  /** Offer `sync` on the session. It records the reasons and moves nothing. */
  sync?: boolean;
  /** Offer `presence`. Defaults to true. */
  presence?: boolean;
}

/** One User's Computer on this host: everything that survives a `close`. */
export class FakeComputerV1 {
  readonly workspace = new FakeWorkspace();
  readonly execCalls: FakeExecCallV1[] = [];
  readonly syncCalls: FakeSyncCallV1[] = [];
  readonly viewerCalls: { action: string; sessionId?: string }[] = [];
  readonly viewerSessions = new Map<string, ComputerViewerSession>();
  readonly leases = new Map<string, ComputerControlLease>();
  readonly processes = new Map<
    string,
    ComputerBackgroundStateV1 & { pid: number; logPath: string; cwd: string }
  >();
  generation = 1;
  private sequence = 0;

  next(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${this.sequence}`;
  }
}

function composed(request: ComputerExecRequest): string {
  return [request.executable, ...(request.args ?? [])].join(" ");
}

function execResult(answer: FakeExecAnswerV1): ComputerExecResult {
  return {
    exitCode: answer.exitCode === undefined ? 0 : answer.exitCode,
    stdout: encoder.encode(answer.stdout ?? ""),
    stderr: encoder.encode(answer.stderr ?? ""),
    outputTruncated: answer.outputTruncated ?? false,
  };
}

/**
 * One lease key. `desktop-gui` is keyed by the Computer and `bot` by the
 * tenant, which is the whole difference between the two scopes.
 */
function leaseKey(botId: string, request?: ComputerControlRequestV1): string {
  return request?.scope === "desktop-gui" ? "desktop-gui" : `bot:${botId}`;
}

const FAKE_DOCTOR_REPORT_V1: ComputerDoctorReportV1 = {
  schemaVersion: 2,
  generation: 1,
  capturedAt: "2026-01-01T00:00:00.000Z",
  checks: [
    { name: "workspace", status: "pass", detail: "the Workspace is writable" },
  ],
  summary: "1 check passed.",
};

/**
 * The in-memory host.
 *
 * One instance is one deployment's Computer host: `computers` holds one
 * `FakeComputerV1` per User, so two Bots of one User share a Workspace and a
 * lease table exactly as two tenants of one real Computer do, and `teardown`
 * destroys that Computer the way the operation it names is meant to.
 */
export class FakeComputerHostV1 implements ComputerHostV1 {
  readonly id: string;
  readonly capabilities: ComputerHostCapabilitiesV1;
  readonly workspaceLayout = FAKE_WORKSPACE_LAYOUT;
  /** Every operation the host was asked for, in order, as `kind:detail`. */
  readonly calls: string[] = [];
  private readonly computers = new Map<string, FakeComputerV1>();

  constructor(private readonly options: FakeComputerHostOptionsV1 = {}) {
    this.id = options.id ?? "fake-computer-host";
    this.capabilities = options.capabilities ?? FAKE_HOST_CAPABILITIES_V1;
  }

  /** The Computer backing one User, created on first reach. */
  computerFor(identity: ComputerIdentityV1): FakeComputerV1 {
    const key = computerIdentityKeyV1(identity);
    let computer = this.computers.get(key);
    if (!computer) {
      computer = new FakeComputerV1();
      this.computers.set(key, computer);
    }
    return computer;
  }

  open(
    identity: ComputerIdentityV1,
    tenant: ComputerTenantV1,
    assignment: ComputerAssignment,
    options?: ComputerOperationOptions,
  ): Promise<ComputerHostSessionV1> {
    options?.signal?.throwIfAborted();
    const botId = computerTenantBotIdV1(tenant);
    const computer = this.computerFor(identity);
    this.calls.push(`open:${identity.userId}:${botId}`);
    return Promise.resolve(this.session(identity, botId, computer, assignment));
  }

  teardown(identity: ComputerIdentityV1): Promise<void> {
    this.calls.push(`teardown:${identity.userId}`);
    // Idempotent by construction: a Computer that is already gone is this
    // operation's outcome, not a failure to report.
    this.computers.delete(computerIdentityKeyV1(identity));
    return Promise.resolve();
  }

  private exec(
    computer: FakeComputerV1,
    botId: string,
    request: ComputerExecRequest,
  ): Promise<ComputerExecResult> {
    const command = composed(request);
    computer.execCalls.push({
      botId,
      command,
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      ...(request.env === undefined ? {} : { env: request.env }),
      ...(request.stdin === undefined
        ? {}
        : { stdin: new TextDecoder().decode(request.stdin) }),
    });
    this.calls.push(`exec:${botId}:${command}`);
    const rule = this.options.exec?.find((entry) =>
      command.includes(entry.match),
    );
    const answer = rule ?? this.options.execDefault ?? {};
    if (answer.fail) return Promise.reject(answer.fail);
    return Promise.resolve(execResult(answer));
  }

  private session(
    identity: ComputerIdentityV1,
    botId: string,
    computer: FakeComputerV1,
    assignment: ComputerAssignment,
  ): ComputerHostSessionV1 {
    const host = this;
    const mint = (): ComputerViewerSession => {
      const id = computer.next("viewer");
      const session: ComputerViewerSession = {
        id,
        url: `${FAKE_VIEWER_ORIGIN}/session/${id}`,
        expiresAt: new Date(1_700_000_900_000).toISOString(),
      };
      computer.viewerSessions.set(id, session);
      return session;
    };
    return {
      assignment,
      identity,
      tenant: {
        botId,
        directory: `/home/box/agent-data/agents/${botId}`,
        display: ":100",
      },
      capabilities: this.capabilities,
      workspace: computer.workspace,
      exec: {
        execute: (request) => host.exec(computer, botId, request),
      },
      screenshot: {
        capture: (): Promise<ComputerScreenshotV1> => {
          host.calls.push(`screenshot:${botId}`);
          return Promise.resolve({
            bytes: host.options.screenshot ?? FAKE_SCREENSHOT_PNG_V1,
            mediaType: "image/png",
            display: ":100",
            capturedAt: "2026-01-01T00:00:00.000Z",
          });
        },
      },
      doctor: {
        run: () => {
          host.calls.push(`doctor:${botId}`);
          return Promise.resolve(host.options.doctor ?? FAKE_DOCTOR_REPORT_V1);
        },
      },
      processes: {
        launch: (request) => {
          host.calls.push(`launch:${botId}:${request.processId}`);
          const record = {
            alive: true,
            logTail: "",
            pid: 1000 + computer.processes.size,
            logPath: `/processes/${request.processId}/log`,
            cwd: `/home/box/agent-data/agents/${botId}`,
          };
          computer.processes.set(request.processId, record);
          return Promise.resolve({
            pid: record.pid,
            logPath: record.logPath,
            cwd: record.cwd,
            generation: computer.generation,
          });
        },
        inspect: (processId) => {
          host.calls.push(`inspect:${botId}:${processId}`);
          const record = computer.processes.get(processId);
          return Promise.resolve(
            record
              ? { alive: record.alive, logTail: record.logTail }
              : { alive: false, logTail: "" },
          );
        },
        stop: (processId) => {
          host.calls.push(`stop:${botId}:${processId}`);
          const record = computer.processes.get(processId);
          if (record) record.alive = false;
          return Promise.resolve({
            alive: false,
            exitCode: 0,
            logTail: record?.logTail ?? "",
          });
        },
        generation: () => Promise.resolve(computer.generation),
      },
      ...(this.options.presence === false
        ? {}
        : {
            presence: {
              connect: () => {
                host.calls.push(`connect:${botId}`);
                return Promise.resolve(mint());
              },
            },
          }),
      viewer: {
        open: () => {
          computer.viewerCalls.push({ action: "open" });
          host.calls.push(`viewer:open:${botId}`);
          return Promise.resolve(mint());
        },
        renew: (sessionId) => {
          computer.viewerCalls.push({ action: "renew", sessionId });
          host.calls.push(`viewer:renew:${botId}`);
          const held = computer.viewerSessions.get(sessionId);
          if (!held) {
            return Promise.reject(
              new ComputerError(
                "provider-unavailable",
                `The Computer has no viewer session "${sessionId}"`,
              ),
            );
          }
          return Promise.resolve(held);
        },
        revoke: (sessionId) => {
          computer.viewerCalls.push({ action: "revoke", sessionId });
          host.calls.push(`viewer:revoke:${botId}`);
          computer.viewerSessions.delete(sessionId);
          return Promise.resolve();
        },
      },
      control: {
        acquire: (request) => {
          const key = leaseKey(botId, request);
          host.calls.push(`control:acquire:${key}`);
          const held = computer.leases.get(key);
          const ownerId = request?.ownerId ?? "anonymous";
          if (held && held.id !== ownerId) {
            return Promise.reject(
              new ComputerError(
                "human-control-active",
                `This Computer's control lease is held by ${held.id}`,
              ),
            );
          }
          const lease: ComputerControlLease = {
            id: ownerId,
            expiresAt: new Date(1_700_000_900_000).toISOString(),
          };
          computer.leases.set(key, lease);
          return Promise.resolve(lease);
        },
        renew: (lease, request) => {
          const key = leaseKey(botId, request);
          host.calls.push(`control:renew:${key}`);
          const held = computer.leases.get(key);
          if (!held || held.id !== lease.id) {
            return Promise.reject(
              new ComputerError(
                "human-control-active",
                "The Computer's control lease owner changed",
              ),
            );
          }
          return Promise.resolve(held);
        },
        release: (lease, request) => {
          const key = leaseKey(botId, request);
          host.calls.push(`control:release:${key}`);
          if (computer.leases.get(key)?.id === lease.id) {
            computer.leases.delete(key);
          }
          return Promise.resolve();
        },
      },
      ...(this.options.sync
        ? {
            sync: {
              reconcile: (
                reason: ComputerSyncReasonV1,
              ): Promise<ComputerSyncSummaryV1> => {
                computer.syncCalls.push({ botId, reason });
                host.calls.push(`sync:${botId}:${reason}`);
                return Promise.resolve(computerSyncSummaryV1("ok"));
              },
              signal: () => Promise.resolve(String(computer.syncCalls.length)),
            },
          }
        : {}),
      close: () => {
        host.calls.push(`close:${botId}`);
        return Promise.resolve();
      },
    };
  }
}

export function createFakeComputerHostV1(
  options?: FakeComputerHostOptionsV1,
): FakeComputerHostV1 {
  return new FakeComputerHostV1(options);
}
