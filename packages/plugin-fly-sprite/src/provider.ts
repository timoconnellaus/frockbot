import { createHash } from "node:crypto";
import {
  ComputerError,
  computerIdentityKeyV1,
  computerSyncSummaryV1,
  computerTenantBotIdV1,
  type ComputerAssignment,
  type ComputerBrowserAction,
  type ComputerBrowserState,
  type ComputerControlLease,
  type ComputerExecRequest,
  type ComputerHandle,
  type ComputerIdentityV1,
  type ComputerOperationOptions,
  type ComputerProvider,
  type ComputerSyncHostV1,
  type ComputerSyncReasonV1,
  type ComputerSyncSummaryV1,
  type ComputerSyncV1,
  type ComputerTenantV1,
  type WorkspaceLayoutV1,
} from "@frockbot/computer-core";
import type { Plugin } from "cordis";
import {
  computerBotKey,
  type BrowserAction,
  type ComputerHostFactoryV1,
  FlySpriteComputer,
  type FlySpriteAgentComputer,
  flySpriteNameForBot,
} from "./computer.js";
import { FlyComputerWorkspace } from "./workspace.js";
import { createFlySpriteSyncV1, type WorkspaceSyncReportV1 } from "./sync.js";

const encoder = new TextEncoder();

/**
 * The durable roots this provider guarantees, laid out to match GrokBot's box
 * (`docs/research/grokbot-computer.md`): `HOME=/home/box`, durable application
 * data under `agent-data`, per-Bot state under `agents/<key>`, and User-shared
 * memory beside it.
 *
 * Memory roots are `read-only` from the Computer's point of view. "The Memory
 * Package is the single writer of Memory roots ... the Workspace presents
 * Memory roots read-only through the durable-root sync" (ADR 0013). That sync
 * is `./sync.ts`: it materializes Memory roots at these mount paths from
 * object storage and never pushes a change back out of them. The User-global
 * instruction root is read-only for the same reason and by the same mechanism
 * (ADR 0016): the Skills Package is its single writer, so a shared root needs
 * no conflict machinery and no Turn has to wake a Computer to read a Skill.
 *
 * `package-declared` roots are User-scoped, because Package availability is
 * User-level and `WorkspaceRootV1` names a Package root by User and Package.
 */
export const FLY_WORKSPACE_LAYOUT: WorkspaceLayoutV1 = {
  schemaVersion: 1,
  home: "/home/box",
  roots: [
    {
      kind: "bot-instructions",
      scope: "bot",
      mountPath: "/home/box/agent-data/agents/{bot}/skills",
      access: "read-write",
    },
    {
      // GrokBot's `agent-data/workflows/<slug>/SKILL.md`: the User's own
      // Skills, global across all of their assistants. Read-only on the
      // Computer — the Skills Package writes it through object storage and
      // the sync only materializes it (ADR 0016, extending ADR 0013's Memory
      // exception).
      kind: "user-instructions",
      scope: "user",
      mountPath: "/home/box/agent-data/workflows",
      access: "read-only",
    },
    {
      kind: "bot-memory",
      scope: "bot",
      mountPath: "/home/box/agent-data/agents/{bot}/memory",
      access: "read-only",
    },
    {
      kind: "user-memory",
      scope: "user",
      mountPath: "/home/box/agent-data/user-memory",
      access: "read-only",
    },
    {
      kind: "package-declared",
      scope: "user",
      mountPath: "/home/box/agent-data/user-packages/{package}/{root}",
      access: "read-write",
    },
  ],
};

function browserAction(action: ComputerBrowserAction): BrowserAction {
  switch (action.type) {
    case "snapshot":
      return { action: "snapshot" };
    case "navigate":
      return { action: "navigate", url: action.url };
    case "click":
      return {
        action: "click",
        role: action.role,
        name: action.name,
        exact: action.exact,
      };
    case "fill":
      return {
        action: "fill",
        label: action.label,
        text: action.text,
        exact: action.exact,
      };
    case "press":
      return { action: "press", key: action.key };
    case "wait":
      return { action: "wait", milliseconds: action.milliseconds };
  }
}

function browserState(output: string): ComputerBrowserState {
  try {
    const parsed: unknown = JSON.parse(output);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "snapshot" in parsed &&
      typeof parsed.snapshot === "string"
    ) {
      const value = parsed as {
        url?: unknown;
        title?: unknown;
        snapshot: string;
      };
      return {
        url: typeof value.url === "string" ? value.url : undefined,
        title: typeof value.title === "string" ? value.title : undefined,
        accessibilitySnapshot: value.snapshot,
      };
    }
  } catch {
    // Preserve provider output as a diagnostic snapshot.
  }
  return { accessibilitySnapshot: output };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function commandFor(
  executable: string,
  args: readonly string[] | undefined,
): string {
  if (
    (executable === "/bin/bash" || executable === "bash") &&
    args?.[0] === "-lc" &&
    typeof args[1] === "string"
  ) {
    return args[1];
  }
  return [executable, ...(args ?? [])].map(shellQuote).join(" ");
}

/**
 * The durable-root sync of ADR 0013, behind the provider-neutral
 * `ComputerSyncV1`.
 *
 * Everything Fly-specific stops here: the reconciliation itself is
 * `./sync.ts`, the object-storage side and the Durable Object records come
 * from the host, and what leaves this class is counts and a status. It exists
 * only while a Computer is open for a Bot, so it can never be the reason a
 * hibernated Computer wakes.
 *
 * `reconcile` never throws. A paused Sprite, a dropped connection, a store
 * that refuses: each is a declared outcome its caller records on the Turn and
 * carries on — "a dropped connection is an outcome, not a failure."
 */
class FlySpriteComputerSync implements ComputerSyncV1 {
  private readonly sync: ReturnType<typeof createFlySpriteSyncV1>;

  constructor(
    computer: FlySpriteAgentComputer,
    identity: ComputerIdentityV1,
    tenant: ComputerTenantV1,
    host: ComputerSyncHostV1,
  ) {
    this.sync = createFlySpriteSyncV1({
      computer,
      layout: FLY_WORKSPACE_LAYOUT,
      userId: identity.userId,
      botDirectoryKey: computerBotKey,
      botIds: [tenant.botId],
      store: host.store,
      ...(host.effects ? { effects: host.effects } : {}),
      ...(host.generations ? { generations: host.generations } : {}),
    });
  }

  async reconcile(
    _reason: ComputerSyncReasonV1,
    options?: ComputerOperationOptions,
  ): Promise<ComputerSyncSummaryV1> {
    if (options?.signal?.aborted) {
      return computerSyncSummaryV1("skipped", "the Turn was cancelled");
    }
    let report: WorkspaceSyncReportV1;
    try {
      report = await this.sync.sync();
    } catch (error) {
      return computerSyncSummaryV1(
        "unavailable",
        error instanceof Error ? error.message : String(error),
      );
    }
    return summarize(report);
  }

  async signal(
    options?: ComputerOperationOptions,
  ): Promise<string | undefined> {
    if (options?.signal?.aborted) return undefined;
    try {
      const outcome = await this.sync.signal();
      return outcome.status === "ok" ? (outcome.text ?? "") : undefined;
    } catch {
      return undefined;
    }
  }
}

function summarize(report: WorkspaceSyncReportV1): ComputerSyncSummaryV1 {
  const total = (
    pick: (root: WorkspaceSyncReportV1["roots"][number]) => number,
  ) => report.roots.reduce((sum, root) => sum + pick(root), 0);
  const failed = report.failures[0];
  const summary: ComputerSyncSummaryV1 = {
    // Every root failing is `unavailable` — the usual shape of a paused
    // Sprite. A partial failure is still an `ok` run that says what it missed.
    status:
      report.failures.length > 0 &&
      report.roots.every((root) => root.failures.length > 0)
        ? "unavailable"
        : "ok",
    detail: failed ? `${failed.status}: ${failed.reason}`.slice(0, 512) : "",
    pulled: total((root) => root.pulled.length),
    pushed: total((root) => root.pushed.length),
    restored: total((root) => root.restored.length),
    removed: total(
      (root) => root.removedOnComputer.length + root.removedInStore.length,
    ),
    adopted: total((root) => root.adopted.length),
    conflicts: report.conflicts.length,
    failures: report.failures.length,
  };
  return summary;
}

/**
 * One bash document for one exec request.
 *
 * `cwd` and `env` become `cd` and `export` lines rather than transport
 * options, and `stdin` is fed to the command from a heredoc, because the whole
 * request travels as a script on the command's own stdin. Nothing reaches an
 * argv, which is what the 431 recorded in ADR 0004 cost to learn.
 */
function composed(request: ComputerExecRequest): string {
  const command = commandFor(request.executable, request.args);
  const lines: string[] = [];
  for (const [key, value] of Object.entries(request.env ?? {})) {
    lines.push(`export ${key}=${shellQuote(value)}`);
  }
  if (request.cwd) lines.push(`cd ${shellQuote(request.cwd)}`);
  if (request.stdin === undefined) {
    lines.push(command);
  } else {
    // A quoted heredoc: the bytes reach the command unexpanded, and a
    // delimiter derived from them cannot appear inside them.
    const marker = `FROCKBOT_STDIN_${createHash("sha256")
      .update(request.stdin)
      .digest("hex")
      .slice(0, 16)
      .toUpperCase()}`;
    lines.push(`${command} <<'${marker}'`);
    lines.push(new TextDecoder().decode(request.stdin));
    lines.push(marker);
  }
  return lines.join("\n");
}

function lease(result: {
  ownerId: string;
  expiresAt?: string;
}): ComputerControlLease {
  return {
    id: result.ownerId,
    // A lease with no expiry would be a lease nothing can reclaim. The host
    // always dates an acquire and a renew; this is the refusal if it ever
    // does not.
    expiresAt: result.expiresAt ?? new Date(0).toISOString(),
  };
}

function handle(
  identity: ComputerIdentityV1,
  tenant: ComputerTenantV1,
  computer: FlySpriteAgentComputer,
  assignment: ComputerAssignment,
  syncHost?: ComputerSyncHostV1,
): ComputerHandle {
  return {
    assignment,
    identity,
    tenant,
    ...(syncHost
      ? {
          sync: new FlySpriteComputerSync(computer, identity, tenant, syncHost),
        }
      : {}),
    workspace: new FlyComputerWorkspace(FLY_WORKSPACE_LAYOUT, {
      computer,
      userId: identity.userId,
      botId: tenant.botId,
      botDirectoryKey: computerBotKey,
      // The Durable Object's generation ledger, when the host supplied one.
      // Without it the Computer's Workspace can attribute nothing, because a
      // sidecar on the Computer is a hint and never an authority.
      ...(syncHost?.generations ? { generations: syncHost.generations } : {}),
    }),
    exec: {
      execute: async (request, options) => {
        // `cwd`, `env`, and `stdin` used to be refused because the Sprites SDK
        // put every one of them into a request URL. The host compiles them
        // into the script it delivers on the command's stdin instead, so they
        // are ordinary parts of a request now.
        const result = await computer.exec(
          composed(request),
          options?.signal ?? new AbortController().signal,
          {
            timeoutMs: request.timeoutMs,
            maxOutputBytes: request.maxOutputBytes,
          },
        );
        return {
          exitCode: result.exitCode,
          stdout: encoder.encode(result.stdout),
          stderr: encoder.encode(result.stderr),
          outputTruncated: result.outputTruncated,
        };
      },
    },
    screenshot: {
      capture: async (options) => {
        const captured = await computer.screenshot(
          options?.signal ?? new AbortController().signal,
        );
        return {
          bytes: captured.bytes,
          mediaType: "image/png",
          display: captured.display,
          capturedAt: captured.capturedAt,
        };
      },
    },
    // The Computer's self-check. Read-only, and not lease-guarded: a Computer
    // under human control is exactly a Computer somebody may need to ask what
    // is wrong with.
    doctor: {
      run: (options) =>
        computer.doctor(options?.signal ?? new AbortController().signal),
    },
    presence: {
      connect: async (options) => {
        const connected = await computer.connect(options);
        return {
          id: connected.viewerSessionId,
          url: connected.viewerUrl,
          ...(connected.viewerExpiresAt
            ? { expiresAt: connected.viewerExpiresAt }
            : {}),
          ...(connected.message ? { message: connected.message } : {}),
        };
      },
    },
    processes: {
      launch: async (request, options) => {
        const launched = await computer.launchProcess(
          request.processId,
          request.command,
          options?.signal ?? new AbortController().signal,
        );
        return {
          pid: launched.pid,
          logPath: launched.logPath,
          cwd: launched.cwd,
          // The generation the launch happened under, which is what a later
          // check compares against to decide whether this is the same
          // Computer at all.
          generation: computer.generation ?? 0,
        };
      },
      inspect: (processId, options) =>
        computer.inspectProcess(
          processId,
          options?.signal ?? new AbortController().signal,
          options?.tailBytes,
        ),
      stop: (processId, options) =>
        computer.stopProcess(
          processId,
          options?.signal ?? new AbortController().signal,
        ),
      // Asked of the host every time, never read from the cached open: a
      // process's whole reconciliation question is whether the Computer
      // answering now is the one it was launched on.
      generation: (options) => computer.currentGeneration(options?.signal),
    },
    browser: {
      perform: async (action, options) =>
        browserState(
          await computer.browser(
            browserAction(action),
            options?.signal ?? new AbortController().signal,
          ),
        ),
    },
    // A viewer and a human-control lease are reachable from the Durable
    // Object now. They were not before: both need the Sprite's URL and its
    // `flock`, and neither was reachable from workerd (ADR 0004).
    viewer: {
      open: async (options) => {
        const result = await computer.viewer(options);
        if (!result.session) {
          throw new ComputerError(
            "provider-unavailable",
            "The Computer host returned no viewer session",
            true,
          );
        }
        return {
          id: result.session.id,
          url: result.session.url,
          ...(result.session.expiresAt
            ? { expiresAt: result.session.expiresAt }
            : {}),
        };
      },
      renew: async (sessionId, options) => {
        const result = await computer.refreshViewer(sessionId, options);
        if (!result.session) {
          throw new ComputerError(
            "provider-unavailable",
            "The Computer host did not renew the viewer session",
            true,
          );
        }
        return {
          id: result.session.id,
          url: result.session.url,
          ...(result.session.expiresAt
            ? { expiresAt: result.session.expiresAt }
            : {}),
        };
      },
      revoke: async (sessionId, options) => {
        await computer.revokeViewer(sessionId, options);
      },
    },
    control: {
      // The scope and the owner travel with the call, so one Computer surface
      // serves both leases: the per-tenant human takeover it always did, and
      // the User-wide `desktop-gui` lease a `computerUse` subagent holds.
      acquire: async (request, options) =>
        lease(await computer.takeControl(options, request)),
      renew: async (_current, request, options) =>
        lease(await computer.refreshControl(options, request)),
      release: (_current, request, options) =>
        computer.releaseControl(options, request),
    },
    close: () => Promise.resolve(),
  };
}

/**
 * One Sprite per User (ADR 0012). The Sprite name is derived from the User and
 * from nothing else, so every Bot the User owns lands on the same Computer,
 * sharing its browser profile, installed tooling, and Workspace.
 */
export function flySpriteNameForComputer(identity: ComputerIdentityV1): string {
  return flySpriteNameForBot(JSON.stringify(["user", identity.userId.trim()]));
}

/** Provider adapter that keeps Fly-specific lifecycle behind Computer core. */
export class FlySpriteComputerProvider implements ComputerProvider {
  readonly id = "fly-sprite";
  readonly workspaceLayout = FLY_WORKSPACE_LAYOUT;
  private readonly computers = new Map<string, FlySpriteComputer>();

  constructor(
    private readonly fixedComputer?: FlySpriteComputer,
    /**
     * The shared Computer host (ADR 0004). Absent, and every Computer this
     * provider opens is unconfigured: the provider Package holds no Sprites
     * SDK and no token, so without a host there is no compute to reach.
     */
    private readonly host?: ComputerHostFactoryV1,
    /**
     * The object-storage side of the durable roots, and the Durable Object
     * records a push depends on. Supplied by the host for one admitted Turn;
     * absent outside one, and the handle then carries no `sync` at all rather
     * than a sync with nowhere to record its intent.
     */
    private readonly syncHost?: ComputerSyncHostV1,
  ) {}

  /**
   * The one Sprite backing a User's Computer. One Computer per User (ADR
   * 0012): every Bot the User owns is a tenant on the instance this returns.
   */
  computerFor(identity: ComputerIdentityV1): FlySpriteComputer {
    if (this.fixedComputer) return this.fixedComputer;
    const key = computerIdentityKeyV1(identity);
    let computer = this.computers.get(key);
    if (!computer) {
      computer = new FlySpriteComputer({
        identity: { userId: identity.userId },
        ...(this.host ? { host: this.host } : {}),
        respectHumanControl: true,
        spriteName: flySpriteNameForComputer(identity),
      });
      this.computers.set(key, computer);
    }
    return computer;
  }

  open(
    identity: ComputerIdentityV1,
    tenant: ComputerTenantV1,
    assignment: ComputerAssignment,
    _options?: ComputerOperationOptions,
  ): Promise<ComputerHandle> {
    computerIdentityKeyV1(identity);
    const botId = computerTenantBotIdV1(tenant);
    const attached = this.computerFor(identity).bot(botId);
    return Promise.resolve(
      handle(
        { userId: identity.userId },
        {
          botId,
          directory: attached.directory,
          ...(attached.display ? { display: attached.display } : {}),
        },
        attached,
        assignment,
        this.syncHost,
      ),
    );
  }
}

export function createFlySpriteProviderPlugin(
  computer?: FlySpriteComputer,
  options?: { host?: ComputerHostFactoryV1; sync?: ComputerSyncHostV1 },
): Plugin.Function {
  const plugin: Plugin.Function = (ctx) =>
    ctx.computers.register(
      new FlySpriteComputerProvider(computer, options?.host, options?.sync),
    );
  plugin.inject = ["computers"];
  return plugin;
}

export const flySpriteProviderPlugin = createFlySpriteProviderPlugin();
export default flySpriteProviderPlugin;
