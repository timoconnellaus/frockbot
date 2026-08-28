import type { Entry } from "@cordisjs/plugin-webui";
import type { ComputerState } from "@frockbot/plugin-computer/shared";
import type { Context, Plugin } from "cordis";
import {
  type ComputerBotIdentity,
  type FlySpriteAgentComputer,
  FlySpriteComputer,
} from "./computer.ts";
import { flySpriteNameForTarget } from "./provider.ts";

export function configuredFlyBotId(
  environment: { FROCKBOT_BOT_ID?: string } = process.env as {
    FROCKBOT_BOT_ID?: string;
  },
): string {
  return environment.FROCKBOT_BOT_ID?.trim() || "barebones";
}

class FlySpriteHostController {
  private readonly computer: FlySpriteAgentComputer;
  private readonly configured: boolean;
  private readonly entry: Entry<ComputerState>;
  private readonly data: ComputerState;
  private heartbeat?: ReturnType<typeof setInterval>;
  private takingControl = false;

  constructor(
    ctx: Context,
    computer: FlySpriteComputer,
    identity: ComputerBotIdentity,
  ) {
    this.computer = computer.bot(identity);
    this.configured = computer.configured;
    const data: ComputerState = {
      phase: computer.configured ? "idle" : "unconfigured",
      botId: this.computer.botId,
      providerLabel: "Fly Sprites",
      message: computer.configured
        ? "Persistent Fly Sprite computer"
        : "Set SPRITES_TOKEN to attach a computer",
      takingControl: false,
      connect: () => this.connect(),
      takeControl: () => this.takeOver(),
      releaseControl: () => this.release(),
      retry: () => this.connect(),
    };
    this.data = data;
    this.entry = ctx.webui.addEntry(
      {
        modulePath: "@frockbot/plugin-computer",
        baseUrl: import.meta.resolve("@frockbot/plugin-computer/package.json"),
        source: "./src/client/index.ts",
        manifest: "./dist/manifest.json",
      },
      data,
    );
  }

  async dispose(): Promise<void> {
    this.stopHeartbeat();
    if (this.takingControl) {
      try {
        await this.computer.releaseControl();
      } catch {
        // Best-effort cleanup during application shutdown.
      }
    }
    this.entry.dispose();
  }

  private async connect(): Promise<void> {
    if (!this.configured) return;
    this.mutate({
      phase: "provisioning",
      message: "Waking and preparing the Sprite computer…",
    });
    try {
      const connection = await this.computer.ensure();
      this.mutate({
        phase: "ready",
        message: "Computer ready",
        viewerUrl: connection.viewerUrl,
        takingControl: false,
      });
    } catch (error) {
      this.fail(error);
    }
  }

  private async takeOver(): Promise<void> {
    if (!this.configured || this.takingControl) return;
    if (!this.current().viewerUrl) await this.connect();
    if (!this.current().viewerUrl) return;
    this.mutate({
      phase: "taking-control",
      message: "Pausing new agent computer actions…",
    });
    try {
      await this.computer.takeControl();
      this.takingControl = true;
      this.startHeartbeat();
      this.mutate({
        phase: "human-control",
        message: "You have control. Release when finished with private data.",
        takingControl: true,
      });
    } catch (error) {
      this.fail(error);
    }
  }

  private async release(): Promise<void> {
    if (!this.takingControl) return;
    try {
      await this.computer.releaseControl();
      this.stopHeartbeat();
      this.takingControl = false;
      this.mutate({
        phase: "ready",
        message: "Computer ready",
        takingControl: false,
      });
    } catch (error) {
      this.fail(error);
    }
  }

  private current(): ComputerState {
    return this.data;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => void this.refreshControl(), 30_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  private async refreshControl(): Promise<void> {
    try {
      await this.computer.refreshControl();
    } catch (error) {
      this.stopHeartbeat();
      this.takingControl = false;
      const detail = error instanceof Error ? error.message : String(error);
      this.mutate({
        phase: "error",
        message: `Human control lease was lost: ${detail}`,
        takingControl: false,
      });
    }
  }

  private mutate(
    patch: Partial<
      Pick<ComputerState, "phase" | "message" | "viewerUrl" | "takingControl">
    >,
  ): void {
    Object.assign(this.data, patch);
    this.entry.mutate((data) => Object.assign(data, patch));
  }

  private fail(error: unknown): void {
    this.mutate({
      phase: "error",
      message: error instanceof Error ? error.message : String(error),
      takingControl: this.takingControl,
    });
  }
}

export function createFlySpriteHostPlugin(
  computer: FlySpriteComputer,
  identity: ComputerBotIdentity = {
    id: configuredFlyBotId(),
    name: process.env.FROCKBOT_AGENT_NAME?.trim() || "Barebones",
  },
): Plugin.Function {
  const plugin: Plugin.Function = (ctx) => {
    const controller = new FlySpriteHostController(ctx, computer, identity);
    return () => controller.dispose();
  };
  plugin.inject = ["webui"];
  return plugin;
}

const defaultUserId = process.env.FROCKBOT_USER_ID?.trim() || "local-user";
const defaultBotId = configuredFlyBotId();

const selectedProvider =
  process.env.FROCKBOT_COMPUTER_PROVIDER?.trim() || "fly-sprite";

export const flySpriteHostPlugin: Plugin.Function =
  selectedProvider === "fly-sprite"
    ? createFlySpriteHostPlugin(
        new FlySpriteComputer({
          respectHumanControl: true,
          spriteName: flySpriteNameForTarget({
            userId: defaultUserId,
            botId: defaultBotId,
          }),
        }),
        {
          id: defaultBotId,
          name: process.env.FROCKBOT_AGENT_NAME?.trim() || "Barebones",
        },
      )
    : () => undefined;

export default flySpriteHostPlugin;
