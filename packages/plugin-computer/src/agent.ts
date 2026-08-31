// The Package that gives a Bot its Computer tools, and the caller of the
// durable-root sync (ADR 0013).
//
// "Bots invoke Computers only through the provider-neutral Computer
// interface", so the sync is reached here as `handle.sync` and never as a
// provider type: this Package does not know which Computer it is driving, and
// the reconciliation itself lives in the provider Package that does.
//
// WHEN THE SYNC RUNS. Three points, and no others:
//
//   open      before this Turn's first Computer tool call, so the Workspace
//             the Bot is about to look at is the one object storage holds.
//   signal    before a later tool call in the same Turn, when the on-Computer
//             watcher's change signal has moved.
//   turn-end  after a Turn that used the Computer, so a shell write on the
//             Computer becomes a durable generation.
//
// It never runs to *reach* a Computer. Every one of those points is inside a
// Turn that already has the Computer open for this Bot: "The Agent loop,
// Memory, Skills, Package composition, and Routines function correctly while
// the Computer is hibernated and do not wake it. The Computer wakes only when
// a Bot uses it" — and while it sleeps the object-storage side is
// authoritative on its own.
//
// A sync that could not run is an outcome, not an error. "Connections to the
// Computer are expected to drop on every pause; every Computer client
// reconnects and resumes rather than treating a dropped connection as
// failure." Every run appends `computer/sync` to the session event log with
// what it moved, and nothing on this path can fail a Turn.
import {
  type SessionStore,
  type ToolDefinition,
} from "@frockbot/kernel-contracts";
import {
  ComputerError,
  type ComputerBrowserAction,
  type ComputerHandle,
  computerSyncSummaryV1,
  type ComputerSyncReasonV1,
  type ComputerSyncSummaryV1,
} from "@frockbot/computer-core";
// Merges the Agent loop's event declarations into the cordis Context type.
import type {} from "@frockbot/kernel-agent-loop/agent";
import type { Plugin } from "cordis";

export interface ComputerAgentPluginConfig {
  userId: string;
  defaultProviderId: string;
  idempotentEffects?: boolean;
}

interface ExecInput {
  command: string;
}

function record(input: unknown): Record<string, unknown> | undefined {
  return typeof input === "object" && input !== null
    ? (input as Record<string, unknown>)
    : undefined;
}

const MAX_EXEC_COMMAND_LENGTH = 20_000;

function decodeExec(input: unknown): ExecInput | undefined {
  const value = record(input);
  const command = value?.command;
  if (typeof command !== "string" || !command.trim()) return undefined;
  if (command.length > MAX_EXEC_COMMAND_LENGTH) return undefined;
  return { command };
}

function decodeBrowser(input: unknown): ComputerBrowserAction | undefined {
  const value = record(input);
  switch (value?.action) {
    case "snapshot":
      return { type: "snapshot" };
    case "navigate":
      return typeof value.url === "string" && value.url
        ? { type: "navigate", url: value.url }
        : undefined;
    case "click":
      return typeof value.role === "string" && typeof value.name === "string"
        ? {
            type: "click",
            role: value.role,
            name: value.name,
            exact: typeof value.exact === "boolean" ? value.exact : undefined,
          }
        : undefined;
    case "fill":
      return typeof value.label === "string" && typeof value.text === "string"
        ? {
            type: "fill",
            label: value.label,
            text: value.text,
            exact: typeof value.exact === "boolean" ? value.exact : undefined,
          }
        : undefined;
    case "press":
      return typeof value.key === "string"
        ? { type: "press", key: value.key }
        : undefined;
    case "wait": {
      const milliseconds = value.milliseconds ?? 500;
      return typeof milliseconds === "number" &&
        milliseconds >= 0 &&
        milliseconds <= 30_000
        ? { type: "wait", milliseconds }
        : undefined;
    }
    default:
      return undefined;
  }
}

function failure(error: unknown): { content: string; isError: true } {
  if (error instanceof ComputerError) {
    return { content: error.message, isError: true };
  }
  return {
    content: error instanceof Error ? error.message : String(error),
    isError: true,
  };
}

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/**
 * The Turn's sync state, and the only place this Package decides to sync.
 *
 * Deep and small on purpose: `beforeUse` and `afterTurn` are the whole
 * surface, they never throw, and every path through them either records a
 * `computer/sync` event or has nothing to record. A caller cannot get the
 * policy wrong because there is no way to ask for a sync at another time.
 */
class ComputerTurnSync {
  #turn = 0;
  #pulled = false;
  #used = false;
  #signal: string | undefined;

  constructor(private readonly sessions: SessionStore) {}

  /** A new Turn forgets the last one's pull, its signal, and its use. */
  beginTurn(turn: number): void {
    if (turn === this.#turn) return;
    this.#turn = turn;
    this.#pulled = false;
    this.#used = false;
    this.#signal = undefined;
  }

  turnUsedTheComputer(turn: number): boolean {
    return this.#used && turn === this.#turn;
  }

  /**
   * Pull before the Turn's first Computer tool call; on later calls, sync
   * again only when the on-Computer watcher says something changed.
   */
  async beforeUse(
    computer: ComputerHandle,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<void> {
    this.#used = true;
    const sync = computer.sync;
    if (!sync) return;
    try {
      if (!this.#pulled) {
        this.#pulled = true;
        await this.record(
          sessionId,
          "open",
          await sync.reconcile("open", { signal }),
        );
        this.#signal = await sync.signal({ signal });
        return;
      }
      const current = await sync.signal({ signal });
      if (current === undefined || current === this.#signal) return;
      this.#signal = current;
      await this.record(
        sessionId,
        "signal",
        await sync.reconcile("signal", { signal }),
      );
    } catch (error) {
      // The Turn is never blocked by its sync, whatever the provider did.
      await this.record(
        sessionId,
        "open",
        computerSyncSummaryV1(
          "unavailable",
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  /** Push after a Turn that used the Computer, and only then. */
  async afterTurn(computer: ComputerHandle, sessionId: string): Promise<void> {
    this.#used = false;
    const sync = computer.sync;
    if (!sync) return;
    await this.record(sessionId, "turn-end", await sync.reconcile("turn-end"));
  }

  /** The Turn could not be given a Computer at all; that is also an outcome. */
  unavailable(sessionId: string, reason: unknown): Promise<void> {
    return this.record(
      sessionId,
      "turn-end",
      computerSyncSummaryV1(
        "unavailable",
        reason instanceof Error ? reason.message : String(reason),
      ),
    );
  }

  private async record(
    sessionId: string,
    reason: ComputerSyncReasonV1,
    summary: ComputerSyncSummaryV1,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.disposed) return;
    session.append({
      type: "computer/sync",
      turn: Math.max(1, this.#turn),
      reason,
      ...summary,
    });
    // The record is durable before anything reports the sync happened.
    await session.flush();
  }
}

async function useComputer<T>(
  computer: ComputerHandle,
  run: (computer: ComputerHandle) => Promise<T>,
): Promise<T> {
  try {
    return await run(computer);
  } finally {
    await computer.close();
  }
}

export function createComputerAgentPlugin(
  config: ComputerAgentPluginConfig,
): Plugin.Function {
  const userId = config.userId.trim();
  const defaultProviderId = config.defaultProviderId.trim();
  if (!userId) throw new Error("Computer user id must be non-empty");
  if (!defaultProviderId) {
    throw new Error("Computer default provider id must be non-empty");
  }

  const plugin: Plugin.Function = (ctx) => {
    // One Computer per User (ADR 0012): the assignment is keyed by the User,
    // and the Bot attaches to it as a tenant.
    const identity = { userId };
    const turnSync = new ComputerTurnSync(ctx.sessions);
    const attach = async (botId: string, signal: AbortSignal) => {
      if (!ctx.computers.assignment(identity)) {
        ctx.computers.assign(identity, defaultProviderId);
      }
      return ctx.computers.open(identity, { botId }, { signal });
    };
    /**
     * Opens the Computer for one tool call and reconciles the durable roots
     * before the Bot looks at them. The sync is inside `open` rather than
     * beside each tool so no Computer tool can be added that skips it.
     */
    const open = async (
      botId: string,
      sessionId: string,
      signal: AbortSignal,
    ) => {
      const computer = await attach(botId, signal);
      await turnSync.beforeUse(computer, sessionId, signal);
      return computer;
    };

    const execTool: ToolDefinition = {
      name: "computer_exec",
      idempotent: config.idempotentEffects === true,
      description:
        "Run a shell command in the Bot's selected persistent Computer. New calls are blocked while the user has taken control.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", maxLength: MAX_EXEC_COMMAND_LENGTH },
        },
        required: ["command"],
        additionalProperties: false,
      },
      validate: (input) => decodeExec(input) !== undefined,
      execute: async (input, context) => {
        const decoded = decodeExec(input);
        if (!decoded)
          return {
            content: `A command of at most ${MAX_EXEC_COMMAND_LENGTH} characters is required`,
            isError: true,
          };
        try {
          return await useComputer(
            await open(context.botId, context.sessionId, context.signal),
            async (computer) => {
              if (!computer.exec) {
                throw new ComputerError(
                  "capability-unavailable",
                  "The selected Computer does not support command execution",
                );
              }
              const result = await computer.exec.execute(
                {
                  executable: "/bin/bash",
                  args: ["-lc", decoded.command],
                  timeoutMs: 120_000,
                  maxOutputBytes: 30_000,
                },
                { signal: context.signal, effectId: context.effectId },
              );
              return {
                content: [text(result.stdout), text(result.stderr)]
                  .filter(Boolean)
                  .join("\n"),
                isError: result.exitCode !== 0,
              };
            },
          );
        } catch (error) {
          return failure(error);
        }
      },
    };

    const browserTool: ToolDefinition = {
      name: "computer_browser",
      idempotent: config.idempotentEffects === true,
      description:
        "Control the browser in the Bot's selected Computer and return an accessibility snapshot.",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["snapshot", "navigate", "click", "fill", "press", "wait"],
          },
          url: { type: "string" },
          role: { type: "string" },
          name: { type: "string" },
          label: { type: "string" },
          text: { type: "string" },
          key: { type: "string" },
          exact: { type: "boolean" },
          milliseconds: { type: "number", minimum: 0, maximum: 30_000 },
        },
        required: ["action"],
        additionalProperties: false,
      },
      validate: (input) => decodeBrowser(input) !== undefined,
      execute: async (input, context) => {
        const action = decodeBrowser(input);
        if (!action)
          return { content: "Invalid browser action", isError: true };
        try {
          return await useComputer(
            await open(context.botId, context.sessionId, context.signal),
            async (computer) => {
              if (!computer.browser) {
                throw new ComputerError(
                  "capability-unavailable",
                  "The selected Computer does not support browser automation",
                );
              }
              const result = await computer.browser.perform(action, {
                signal: context.signal,
                effectId: context.effectId,
              });
              return {
                content: result.accessibilitySnapshot,
                isError: false,
              };
            },
          );
        } catch (error) {
          return failure(error);
        }
      },
    };

    return [
      ctx.tools.register(execTool),
      ctx.tools.register(browserTool),
      // A Turn's first step is where the Turn's sync state begins; a Turn that
      // never touches the Computer never syncs and never wakes one.
      ctx.on("agent/pre-step", (_agent, _inputs, turn, _step, next) => {
        turnSync.beginTurn(turn);
        return next();
      }),
      // "after a Turn that used the Computer": the Computer is already awake
      // for this Bot, so the push costs no wake, and a Sprite that paused
      // mid-Turn answers `unavailable` and the next run finishes the work.
      ctx.on("agent/turn-stopping", async (agent, turn) => {
        if (!turnSync.turnUsedTheComputer(turn)) return;
        let computer;
        try {
          computer = await attach(agent.botId, new AbortController().signal);
        } catch (error) {
          await turnSync.unavailable(agent.session.id, error);
          return;
        }
        try {
          await turnSync.afterTurn(computer, agent.session.id);
        } catch (error) {
          await turnSync.unavailable(agent.session.id, error);
        } finally {
          await computer.close();
        }
      }),
      ctx.systemPrompt.register({
        id: "persistent-computer",
        order: 80,
        render: () =>
          [
            "## Persistent Computer",
            "You share a persistent Linux Computer with your User's other Bots. You have your own directories and desktop on it; the browser profile is shared.",
            "Use computer_exec to inspect the filesystem before claiming that a path or file exists.",
            "Never invent a directory listing.",
          ].join("\n"),
      }),
    ];
  };
  plugin.inject = ["computers", "tools", "systemPrompt", "sessions"];
  return plugin;
}

export default createComputerAgentPlugin;
