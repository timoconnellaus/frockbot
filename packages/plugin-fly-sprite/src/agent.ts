import type { ToolDefinition } from "@frockbot/agent-core";
import type { Plugin } from "cordis";
import { type BrowserAction, FlySpriteComputer } from "./computer.ts";

interface ExecInput {
  command: string;
}

function record(input: unknown): Record<string, unknown> | undefined {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : undefined;
}

function decodeExec(input: unknown): ExecInput | undefined {
  const value = record(input);
  const command = value?.command;
  if (
    typeof command !== "string" ||
    !command.trim() ||
    command.length > 20_000
  ) {
    return undefined;
  }
  return { command };
}

function decodeBrowser(input: unknown): BrowserAction | undefined {
  const value = record(input);
  if (!value) return undefined;
  const action = value.action;
  if (
    action !== "snapshot" &&
    action !== "navigate" &&
    action !== "click" &&
    action !== "fill" &&
    action !== "press" &&
    action !== "wait"
  ) {
    return undefined;
  }
  if (action === "navigate" && typeof value.url !== "string") return undefined;
  if (
    action === "click" &&
    (typeof value.role !== "string" || typeof value.name !== "string")
  ) {
    return undefined;
  }
  if (
    action === "fill" &&
    (typeof value.label !== "string" || typeof value.text !== "string")
  ) {
    return undefined;
  }
  if (action === "press" && typeof value.key !== "string") return undefined;
  if (
    action === "wait" &&
    value.milliseconds !== undefined &&
    (typeof value.milliseconds !== "number" ||
      !Number.isFinite(value.milliseconds) ||
      value.milliseconds < 0 ||
      value.milliseconds > 30_000)
  ) {
    return undefined;
  }
  return {
    action,
    url: typeof value.url === "string" ? value.url : undefined,
    role: typeof value.role === "string" ? value.role : undefined,
    name: typeof value.name === "string" ? value.name : undefined,
    label: typeof value.label === "string" ? value.label : undefined,
    text: typeof value.text === "string" ? value.text : undefined,
    key: typeof value.key === "string" ? value.key : undefined,
    exact: typeof value.exact === "boolean" ? value.exact : undefined,
    milliseconds:
      typeof value.milliseconds === "number" ? value.milliseconds : undefined,
  };
}

function failure(error: unknown): { content: string; isError: true } {
  return {
    content: error instanceof Error ? error.message : String(error),
    isError: true,
  };
}

export function createFlySpriteAgentPlugin(
  computer: FlySpriteComputer,
): Plugin.Function {
  const plugin: Plugin.Function = (ctx) => {
    const execTool: ToolDefinition = {
      name: "computer_exec",
      description:
        "Run a shell command in the bot's persistent Fly Sprite computer. New calls are blocked while the user has taken control.",
      inputSchema: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
        additionalProperties: false,
      },
      validate: (input) => decodeExec(input) !== undefined,
      execute: async (input, context) => {
        const decoded = decodeExec(input);
        if (!decoded)
          return { content: "A command is required", isError: true };
        try {
          return {
            content: await computer.run(decoded.command, context.signal),
            isError: false,
          };
        } catch (error) {
          return failure(error);
        }
      },
    };

    const browserTool: ToolDefinition = {
      name: "computer_browser",
      description:
        "Control Chromium in the bot's Fly Sprite computer and return an accessibility snapshot. Actions: snapshot, navigate(url), click(role,name), fill(label,text), press(key), wait(milliseconds). Calls are blocked during human control.",
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
          milliseconds: { type: "number", minimum: 0, maximum: 30000 },
        },
        required: ["action"],
        additionalProperties: false,
      },
      validate: (input) => decodeBrowser(input) !== undefined,
      execute: async (input, context) => {
        const decoded = decodeBrowser(input);
        if (!decoded) {
          return { content: "Invalid browser action", isError: true };
        }
        try {
          return {
            content: await computer.browser(decoded, context.signal),
            isError: false,
          };
        } catch (error) {
          return failure(error);
        }
      },
    };

    return [ctx.tools.register(execTool), ctx.tools.register(browserTool)];
  };
  plugin.inject = ["tools"];
  return plugin;
}

export const flySpriteAgentPlugin = createFlySpriteAgentPlugin(
  new FlySpriteComputer({ respectHumanControl: true }),
);

export default flySpriteAgentPlugin;
