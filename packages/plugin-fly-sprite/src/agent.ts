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
            content: await computer
              .agent(context.agentId)
              .run(decoded.command, context.signal),
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
            content: await computer
              .agent(context.agentId)
              .browser(decoded, context.signal),
            isError: false,
          };
        } catch (error) {
          return failure(error);
        }
      },
    };

    const disposers = [
      ctx.tools.register(execTool),
      ctx.tools.register(browserTool),
      ctx.systemPrompt.register({
        id: "persistent-computer",
        order: 80,
        render: () =>
          [
            "## Persistent computer",
            "You have a persistent Linux computer shared with the user's other bots.",
            "Your shell starts in /workspace with HOME=/home/box. Durable application data is under /home/box/agent-data.",
            "Your bot has its own desktop, Chromium profile, memory folder, automations folder, skills folder, and transcript mirror.",
            "Other bots share the filesystem but use separate desktop and browser sessions.",
            "Use computer_exec to inspect the filesystem before claiming that a path or file exists. Never invent a directory listing.",
            "The automations folder is storage only until an automation runtime is installed; do not claim stored files are scheduled or running.",
          ].join("\n"),
      }),
    ];
    if (computer.configured) {
      disposers.push(
        ctx.on("agent/request", async (agent, _request, signal, next) => {
          const resolved = await next();
          try {
            const memory = await computer
              .agent(agent.id)
              .readStandingMemory(signal);
            if (!memory.trim()) return resolved;
            return {
              ...resolved,
              system: [resolved.system.trim(), memory]
                .filter(Boolean)
                .join("\n\n"),
            };
          } catch {
            return resolved;
          }
        }),
      );
      disposers.push(
        ctx.on("agent/turn-stopping", async (agent) => {
          try {
            await computer
              .agent(agent.id)
              .writeTranscript(agent.session.events);
          } catch {
            // The canonical in-process session must still settle when a mirror fails.
          }
        }),
      );
    }
    return disposers;
  };
  plugin.inject = ["tools", "systemPrompt"];
  return plugin;
}

export const flySpriteAgentPlugin = createFlySpriteAgentPlugin(
  new FlySpriteComputer({ respectHumanControl: true }),
);

export default flySpriteAgentPlugin;
