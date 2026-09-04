/**
 * Test support: a double for the shared Computer host (ADR 0004).
 *
 * It is a module under `src` rather than a fixture inside one test file
 * because three suites need the same one — `computer.test.ts`,
 * `workspace.test.ts`, and `sync.test.ts` all drive a `FlySpriteComputer`, and
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
import {
  COMPUTER_HOST_LIMITS,
  type ComputerHostControlResultV1,
  type ComputerHostFileReadResultV1,
  type ComputerHostOpenResultV1,
  type ComputerHostProvisioningV1,
  type ComputerHostViewerResultV1,
} from "@frockbot/computer-host-protocol";
import { DESKTOP_GUI_LEASE_KEY } from "@frockbot/computer-host-runtime";
import {
  computerBotKey,
  type ComputerHostFactoryV1,
  type ComputerHostSurfaceV1,
} from "./computer.ts";
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
          spriteName: host.spriteName,
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
