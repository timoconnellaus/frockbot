/**
 * Test support: a double for the shared Computer host.
 *
 * It is a module under `src` rather than a fixture inside one test file
 * because three suites need the same one — `computer.test.ts`,
 * `workspace.test.ts`, and `sync.test.ts` all drive a `FlyComputer`, and
 * a double per suite would let three of them drift from one contract. It is
 * deliberately absent from this Package's `exports`, so nothing outside can
 * reach it, and it is not a `*.test.ts` file, so `bun test` never runs it as
 * one.
 *
 * What it stands in for is the host, not the Computer: it holds the
 * human-control leases the Sprite's `flock` would hold, answers `open` and
 * `viewer` with the shape the container answers, and hands every script to a
 * runner the suite supplies. What it does not do is HTTP — the wire is
 * `host-client.test.ts`'s subject and the workerd suite's, and repeating it
 * here would test the transport three more times and the provider none.
 */
import { createHash } from "node:crypto";
import { WORKSPACE_MAX_FILE_BYTES } from "@frockbot/core/contracts";
import {
  COMPUTER_HOST_LIMITS,
  type ComputerHostControlResultV1,
  type ComputerHostFileReadResultV1,
  type ComputerHostOpenResultV1,
  type ComputerHostProvisioningV1,
  type ComputerHostViewerResultV1,
} from "@frockbot/computer/host-protocol";
import type { ComputerHostV1 } from "@frockbot/computer/core/host";
import { BOTS_ROOT, DESKTOP_GUI_LEASE_KEY } from "./runtime.js";
import {
  computerBotKey,
  FlyComputer,
  MAX_STORAGE_OUTPUT,
  type ComputerHostFactoryV1,
  type ComputerHostSurfaceV1,
} from "./computer.ts";
import { FlyComputerHostV1 } from "./provider.ts";
import type {
  ComputerHostCallOptions,
  ComputerHostExecCommandV1,
  ComputerHostExecOutcomeV1,
  ComputerHostOpenOptionsV1,
} from "./host-client.ts";

/** What a suite's runner says one script did. */
export interface FakeComputerRunV1 {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  outputTruncated?: boolean;
}

export type FakeComputerRunnerV1 = (
  script: string,
) => FakeComputerRunV1 | Promise<FakeComputerRunV1>;

/** One script the host was asked to run, in order. */
export interface FakeComputerCommandV1 {
  botId: string;
  script: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

interface FakeLease {
  owner: string;
  fresh: boolean;
}

const GUARD = /control\.sh assert-agent '([^']+)' '([^']+)' '([^']+)'/;
/** The exit code the Computer's control script uses for a refused assertion. */
const HUMAN_CONTROL_EXIT = 73;
const HUMAN_CONTROL_MESSAGE = "The user is controlling this agent's computer";

const encoder = new TextEncoder();

/**
 * A Computer host whose Computer is whatever the suite's runner says.
 *
 * One instance is one User's Computer: `factory` hands out a per-tenant
 * surface, and the leases are shared across them exactly as one Sprite's
 * `flock` is shared across a User's Bots.
 */
export class FakeComputerHost {
  readonly commands: FakeComputerCommandV1[] = [];
  readonly leases = new Map<string, FakeLease>();
  readonly viewerSessions: Array<{ botId: string; action: string }> = [];
  spriteName = "frockbot-test";
  viewerUrl =
    "https://frockbot-test-123.sprites.app/vnc.html#autoconnect=1&password=secret-pass";
  display: string | undefined = ":100";
  generation = 1;
  provisioning?: ComputerHostProvisioningV1;
  readonly openProgress: ComputerHostProvisioningV1[] = [];
  /** Set to refuse the next `open`, the way an exhausted slot pool does. */
  openFailure?: Error;
  /** The bytes `file/read` answers with, by absolute path on the Computer. */
  readonly files = new Map<string, Uint8Array>();
  /** Every `file/read` the host was asked for, in order. */
  readonly reads: Array<{ botId: string; path: string }> = [];

  constructor(private runner: FakeComputerRunnerV1 = () => ({})) {}

  /** Replaces the runner, so a suite can change behaviour mid-test. */
  runs(runner: FakeComputerRunnerV1): void {
    this.runner = runner;
  }

  /** The scripts this host ran, joined — what a suite usually asserts on. */
  get scripts(): string[] {
    return this.commands.map((command) => command.script);
  }

  readonly factory: ComputerHostFactoryV1 = (_identity, tenant) =>
    this.surface(tenant.botId);

  surface(botId: string): ComputerHostSurfaceV1 {
    const host = this;
    const botKey = computerBotKey(botId);
    return {
      async open(
        options?: ComputerHostOpenOptionsV1,
      ): Promise<ComputerHostOpenResultV1> {
        options?.signal?.throwIfAborted();
        if (host.openFailure) throw host.openFailure;
        for (const progress of host.openProgress) {
          await options?.onProgress?.(progress);
        }
        return {
          version: 1,
          effectId: options?.effectId ?? "effect-open",
          instanceId: host.spriteName,
          directory: `/home/box/agent-data/agents/${botKey}`,
          ...(host.display ? { display: host.display } : {}),
          generation: host.generation,
          ...(host.provisioning ? { provisioning: host.provisioning } : {}),
        };
      },

      async exec(
        command: ComputerHostExecCommandV1,
        options?: ComputerHostCallOptions,
      ): Promise<ComputerHostExecOutcomeV1> {
        options?.signal?.throwIfAborted();
        // The real host's decoder refuses an oversized script, and a double
        // that accepted one would let a suite prove a push works at a size the
        // Computer would never have been handed.
        if (command.script.length > COMPUTER_HOST_LIMITS.script) {
          throw new Error(
            `script exceeds ${COMPUTER_HOST_LIMITS.script} characters`,
          );
        }
        host.commands.push({
          botId,
          script: command.script,
          ...(command.timeoutMs === undefined
            ? {}
            : { timeoutMs: command.timeoutMs }),
          ...(command.maxOutputBytes === undefined
            ? {}
            : { maxOutputBytes: command.maxOutputBytes }),
        });
        const refused = host.assert(command.script);
        if (refused) return refused;
        const run = await host.runner(command.script);
        return {
          effectId: options?.effectId ?? "effect-exec",
          exitCode: run.exitCode ?? 0,
          stdout: encoder.encode(run.stdout ?? ""),
          stderr: encoder.encode(run.stderr ?? ""),
          outputTruncated: run.outputTruncated ?? false,
        };
      },

      fileRead(
        path: string,
        options?: ComputerHostCallOptions,
      ): Promise<ComputerHostFileReadResultV1> {
        options?.signal?.throwIfAborted();
        host.reads.push({ botId, path });
        const bytes = host.files.get(path);
        if (!bytes) {
          return Promise.reject(new Error(`no such file: ${path}`));
        }
        return Promise.resolve({
          version: 1,
          effectId: options?.effectId ?? "effect-file-read",
          entry: {
            path,
            kind: "file",
            size: bytes.byteLength,
            mode: 0o600,
          },
          bytesBase64: Buffer.from(bytes).toString("base64"),
        });
      },

      control(
        action: "acquire" | "renew" | "release",
        ownerId: string,
        maxAgeSeconds: number,
        options?: ComputerHostCallOptions & {
          scope?: "bot" | "desktop-gui";
        },
      ): Promise<ComputerHostControlResultV1> {
        options?.signal?.throwIfAborted();
        const leaseKey =
          options?.scope === "desktop-gui" ? DESKTOP_GUI_LEASE_KEY : botKey;
        const lease = host.leases.get(leaseKey);
        if (action === "acquire") {
          if (lease?.fresh && lease.owner !== ownerId) {
            return Promise.reject(new Error("human control is active"));
          }
          host.leases.set(leaseKey, { owner: ownerId, fresh: true });
        } else if (action === "renew") {
          if (lease?.owner !== ownerId) {
            return Promise.reject(new Error("lease owner changed"));
          }
          lease.fresh = true;
        } else if (lease?.owner === ownerId) {
          host.leases.delete(leaseKey);
        }
        return Promise.resolve({
          version: 1,
          effectId: options?.effectId ?? "effect-control",
          action,
          ownerId,
          ...(action === "release"
            ? {}
            : {
                expiresAt: new Date(
                  Date.now() + maxAgeSeconds * 1_000,
                ).toISOString(),
              }),
        });
      },

      viewer(
        action: "open" | "renew" | "revoke",
        options?: ComputerHostCallOptions & { sessionId?: string },
      ): Promise<ComputerHostViewerResultV1> {
        options?.signal?.throwIfAborted();
        host.viewerSessions.push({ botId, action });
        return Promise.resolve({
          version: 1,
          effectId: options?.effectId ?? "effect-viewer",
          ...(action === "revoke"
            ? {}
            : {
                session: {
                  id: "secret-token",
                  url: host.viewerUrl,
                  expiresAt: new Date(Date.now() + 900_000).toISOString(),
                },
              }),
        });
      },
    };
  }

  /**
   * Applies the human-control guard the script carries.
   *
   * The guard is a line of bash on a real Computer, so a double that ignored
   * it would let a suite prove the provider respects a lease it never
   * consulted. Exit 73 is what the Computer's own control script answers.
   */
  private assert(script: string): ComputerHostExecOutcomeV1 | undefined {
    const match = GUARD.exec(script);
    if (!match) return undefined;
    const [, botKey = "", desktopKey = "", owner = ""] = match;
    for (const key of [botKey, desktopKey]) {
      const lease = this.leases.get(key);
      if (lease?.fresh && lease.owner !== owner) {
        return {
          effectId: "effect-refused",
          exitCode: HUMAN_CONTROL_EXIT,
          stdout: encoder.encode(""),
          stderr: encoder.encode(`${HUMAN_CONTROL_MESSAGE}: ${lease.owner}`),
          outputTruncated: false,
        };
      }
      if (lease && !lease.fresh) this.leases.delete(key);
    }
    return undefined;
  }
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function quoted(shell: string, name: string): string | undefined {
  return new RegExp(`${name}='([^']*)'`).exec(shell)?.[1];
}

/**
 * A Computer whose durable filesystem is an in-memory map. It interprets the
 * shell the Workspace surface emits rather than running it, because the
 * scripts are GNU coreutils and the test host is not.
 */
export class FakeWorkspaceDisk {
  readonly files = new Map<string, { bytes: Uint8Array; meta?: string }>();
  offline = false;
  modifiedSeconds = 1_700_000_000;

  /** Every script this disk was handed, in order. */
  readonly scripts: string[] = [];
  /** Rewrites the file at this path between two chunk commands of one read. */
  midReadRewrite?: { path: string; bytes: Uint8Array };

  /** The runner the shared host double hands every script to. */
  readonly run = (script: string): FakeComputerRunV1 => {
    this.scripts.push(script);
    if (this.offline) return { exitCode: 1, stderr: "Sprite is paused" };
    // The real host's storage surface refuses an answer past this, so a double
    // that returned one would let a suite prove a read works at a size the
    // Computer would never have carried.
    const bounded = (stdout: string): FakeComputerRunV1 =>
      stdout.length > MAX_STORAGE_OUTPUT
        ? { stdout: stdout.slice(0, MAX_STORAGE_OUTPUT), outputTruncated: true }
        : { stdout };
    if (script.includes("__STAGED__")) {
      return bounded(this.stageChunk(script));
    }
    const root = quoted(script, "ROOT");
    const relative = quoted(script, "REL");
    if (!root) return {};
    if (script.includes("__WRITTEN__") && relative) {
      return bounded(this.write(`${root}/${relative}`, script));
    }
    if (script.includes("__DELETED__") && relative) {
      return bounded(this.remove(`${root}/${relative}`, script));
    }
    if (script.includes('find "$ROOT"')) {
      return bounded(this.list(root, script));
    }
    if (relative) {
      return bounded(this.load(`${root}/${relative}`, script));
    }
    return {};
  };

  private current(path: string): string {
    const entry = this.files.get(path);
    if (!entry) return "";
    if (!entry.meta) return "__UNRECORDED__";
    return (
      Buffer.from(entry.meta, "base64").toString("utf8").split("\n")[0] ?? ""
    );
  }

  private expected(shell: string): string {
    return /if \[ "\$CURRENT" != '([^']*)' \]/.exec(shell)?.[1] ?? "";
  }

  /** One appended chunk of a staged file, as the write stages it. */
  private stageChunk(shell: string): string {
    const path = quoted(shell, "STAGE") ?? "";
    const encoded =
      /printf %s '([^']*)' \| base64 -d >> "\$STAGE"/.exec(shell)?.[1] ?? "";
    const chunk = Buffer.from(encoded, "base64");
    const held = shell.includes('rm -f "$STAGE"')
      ? undefined
      : this.files.get(path)?.bytes;
    this.files.set(path, {
      bytes: Uint8Array.from(
        held ? Buffer.concat([Buffer.from(held), chunk]) : chunk,
      ),
    });
    return "__STAGED__\n";
  }

  private write(path: string, shell: string): string {
    const stage = quoted(shell, "STAGE");
    if (this.current(path) !== this.expected(shell)) {
      if (stage) this.files.delete(stage);
      return "__CONFLICT__\n";
    }
    const meta = /printf %s '([^']*)' \| base64 -d > "\$MTMP"/.exec(shell)?.[1];
    let bytes: Uint8Array;
    if (stage) {
      // The staged bytes are digest-checked exactly as the emitted
      // `sha256sum` line checks them, so a torn staging file is __CORRUPT__
      // here for the same reason it would be on the Sprite.
      const staged = this.files.get(stage)?.bytes ?? new Uint8Array();
      this.files.delete(stage);
      const expected = /f1\)" != '([0-9a-f]{64})'/.exec(shell)?.[1];
      if (expected && sha256(staged) !== expected) return "__CORRUPT__\n";
      bytes = staged;
    } else {
      const inline = /printf %s '([^']*)' \| base64 -d > "\$TMP"/.exec(
        shell,
      )?.[1];
      bytes = Uint8Array.from(Buffer.from(inline ?? "", "base64"));
    }
    this.files.set(path, { bytes, meta });
    return "__WRITTEN__\n";
  }

  private remove(path: string, shell: string): string {
    if (!this.files.has(path)) return "__MISSING__\n";
    if (this.current(path) !== this.expected(shell)) return "__CONFLICT__\n";
    this.files.delete(path);
    return "__DELETED__\n";
  }

  /**
   * The chunked file read: a header of sidecar, digest, size, and mtime with
   * the first chunk, then one chunk per further command. `head -c` and
   * `tail -c +N` are the coreutils the Workspace emits; the arithmetic is
   * theirs, not an approximation.
   */
  private load(path: string, shell: string): string {
    const chunk = /tail -c \+(\d+) "\$TARGET" \| head -c (\d+)/.exec(shell);
    if (chunk) {
      // A rewrite between two chunk commands is what makes a read report
      // rather than stitch, so the double performs one where a test asks.
      const rewrite = this.midReadRewrite;
      if (rewrite) {
        this.midReadRewrite = undefined;
        this.files.set(rewrite.path, { bytes: rewrite.bytes });
      }
      const offset = Number(chunk[1]) - 1;
      const limit = Number(chunk[2]);
      const bytes = this.files.get(path)?.bytes;
      const slice = bytes?.subarray(offset, offset + limit) ?? new Uint8Array();
      return `${Buffer.from(slice).toString("base64")}\n`;
    }
    const entry = this.files.get(path);
    if (!entry) return "__MISSING__\n";
    if (entry.bytes.byteLength > WORKSPACE_MAX_FILE_BYTES) {
      return "__TOO_LARGE__\n";
    }
    const lines = [
      entry.meta ?? "",
      sha256(entry.bytes),
      String(entry.bytes.byteLength),
      String(this.modifiedSeconds),
    ];
    const head = /head -c (\d+) "\$TARGET" \| base64 -w0/.exec(shell);
    if (head) {
      lines.push(
        Buffer.from(entry.bytes.subarray(0, Number(head[1]))).toString(
          "base64",
        ),
      );
    }
    return `${lines.join("\n")}\n`;
  }

  private list(root: string, shell: string): string {
    const offset = Number(/OFFSET=(\d+)/.exec(shell)?.[1] ?? 0);
    const limit = Number(/LIMIT=(\d+)/.exec(shell)?.[1] ?? 100);
    const prefix = quoted(shell, "PREFIX") ?? "";
    const rows = [...this.files.entries()]
      .filter(([path]) => path.startsWith(`${root}/`))
      .map(([path, entry]) => [path.slice(root.length + 1), entry] as const)
      // The emitted `find` prunes the lock, generation, and sync directories,
      // so a listing never shows a staging file mid-write.
      .filter(([relative]) => !relative.startsWith(".frockbot-"))
      .filter(
        ([relative]) =>
          !prefix || relative === prefix || relative.startsWith(`${prefix}/`),
      )
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .slice(offset, offset + limit + 1)
      .map(([relative, entry]) =>
        [
          Buffer.from(relative).toString("base64"),
          entry.meta ?? "",
          sha256(entry.bytes),
          String(entry.bytes.byteLength),
          String(this.modifiedSeconds),
        ].join("\t"),
      );
    return rows.length ? `${rows.join("\n")}\n` : "";
  }
}

/**
 * This implementation, standing up as a `ComputerHostV1` for the shared
 * contract suite.
 *
 * It lives here rather than in `computer/host-contract.test.ts` because
 * everything it has to say is this implementation's own vocabulary — the
 * instance name, the exit marker its exec protocol carries, the byte count
 * `scrot` prints beside the PNG a read brings back — and the contract suite is
 * the one file that must contain none of it. What the suite gets is a host.
 */
export function contractHostV1(userId: string, botId: string): ComputerHostV1 {
  const disk = new FakeWorkspaceDisk();
  const png = new Uint8Array(64);
  png.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  const double = new FakeComputerHost((script) => {
    if (script.includes("scrot")) return { stdout: "64\n" };
    if (script.includes("__FROCKBOT_EXIT__")) {
      return { stdout: "contract\n__FROCKBOT_EXIT__0\n" };
    }
    return disk.run(script);
  });
  double.files.set(`${BOTS_ROOT}/${computerBotKey(botId)}/screenshot.png`, png);
  return new FlyComputerHostV1(
    new FlyComputer({
      identity: { userId },
      host: double.factory,
      spriteName: "frockbot-contract",
    }),
  );
}
