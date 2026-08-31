import { type ToolDefinition } from "@frockbot/kernel-contracts";
import {
  ComputerError,
  type ComputerBrowserAction,
  type ComputerHandle,
} from "@frockbot/computer-core";
import type { Plugin } from "cordis";

export interface ComputerAgentPluginConfig {
  userId: string;
  defaultProviderId: string;
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
    const open = async (botId: string, signal: AbortSignal) => {
      if (!ctx.computers.assignment(identity)) {
        ctx.computers.assign(identity, defaultProviderId);
      }
      return ctx.computers.open(identity, { botId }, { signal });
    };

    const execTool: ToolDefinition = {
      name: "computer_exec",
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
            await open(context.botId, context.signal),
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
                { signal: context.signal },
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
            await open(context.botId, context.signal),
            async (computer) => {
              if (!computer.browser) {
                throw new ComputerError(
                  "capability-unavailable",
                  "The selected Computer does not support browser automation",
                );
              }
              const result = await computer.browser.perform(action, {
                signal: context.signal,
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
  plugin.inject = ["computers", "tools", "systemPrompt"];
  return plugin;
}

export default createComputerAgentPlugin;
