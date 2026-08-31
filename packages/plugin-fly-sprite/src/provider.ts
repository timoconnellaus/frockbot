import {
  ComputerError,
  computerIdentityKeyV1,
  computerTenantBotIdV1,
  type ComputerAssignment,
  type ComputerBrowserAction,
  type ComputerBrowserState,
  type ComputerHandle,
  type ComputerIdentityV1,
  type ComputerOperationOptions,
  type ComputerProvider,
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
 * does not exist yet; until it does, the Memory Package writes these mounts
 * through `ComputerWorkspace.memoryWriter`, the seam Step 3 of
 * `docs/plans/slice-2.md` replaces.
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

function handle(
  identity: ComputerIdentityV1,
  tenant: ComputerTenantV1,
  computer: FlySpriteAgentComputer,
  assignment: ComputerAssignment,
): ComputerHandle {
  return {
    assignment,
    identity,
    tenant,
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
      ),
    );
  }
}

export function createFlySpriteProviderPlugin(
  computer?: FlySpriteComputer,
  options?: { token?: string },
): Plugin.Function {
  const plugin: Plugin.Function = (ctx) =>
    ctx.computers.register(
      new FlySpriteComputerProvider(computer, options?.token),
    );
  plugin.inject = ["computers"];
  return plugin;
}

export const flySpriteProviderPlugin = createFlySpriteProviderPlugin();
export default flySpriteProviderPlugin;
