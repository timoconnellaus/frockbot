import {
  ComputerError,
  computerIdentityKeyV1,
  computerSyncSummaryV1,
  computerTenantBotIdV1,
  type ComputerAssignment,
  type ComputerBrowserAction,
  type ComputerBrowserState,
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
 * object storage and never pushes a change back out of them.
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
    }),
    exec: {
      execute: async (request, options) => {
        if (
          request.cwd !== undefined ||
          request.env !== undefined ||
          request.stdin !== undefined
        ) {
          throw new ComputerError(
            "invalid-request",
            "The Fly Computer provider does not support cwd, env, or stdin",
          );
        }
        const result = await computer.exec(
          commandFor(request.executable, request.args),
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
    browser: {
      perform: async (action, options) =>
        browserState(
          await computer.browser(
            browserAction(action),
            options?.signal ?? new AbortController().signal,
          ),
        ),
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
    private readonly token?: string,
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
        token: this.token,
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
  options?: { token?: string; sync?: ComputerSyncHostV1 },
): Plugin.Function {
  const plugin: Plugin.Function = (ctx) =>
    ctx.computers.register(
      new FlySpriteComputerProvider(computer, options?.token, options?.sync),
    );
  plugin.inject = ["computers"];
  return plugin;
}

export const flySpriteProviderPlugin = createFlySpriteProviderPlugin();
export default flySpriteProviderPlugin;
