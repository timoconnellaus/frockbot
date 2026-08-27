import type { Entry } from "@cordisjs/plugin-webui";
import type { Context, Plugin } from "cordis";
import {
  type ComputerAgentIdentity,
  type FlySpriteAgentComputer,
  FlySpriteComputer,
} from "./computer.ts";
import type { FlySpriteComputerState } from "./shared.ts";

class FlySpriteHostController {
  private readonly computer: FlySpriteAgentComputer;
  private readonly configured: boolean;
  private readonly entry: Entry<FlySpriteComputerState>;
  private readonly data: FlySpriteComputerState;
  private heartbeat?: ReturnType<typeof setInterval>;
  private takingControl = false;

  constructor(
    ctx: Context,
    computer: FlySpriteComputer,
    identity: ComputerAgentIdentity,
  ) {
    this.computer = computer.agent(identity);
    this.configured = computer.configured;
    const data: FlySpriteComputerState = {
      phase: computer.configured ? "idle" : "missing-token",
      agentId: this.computer.agentId,
      spriteName: computer.spriteName,
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
        modulePath: "@frockbot/plugin-fly-sprite",
        baseUrl: import.meta.resolve(
          "@frockbot/plugin-fly-sprite/package.json",
        ),
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

  private current(): FlySpriteComputerState {
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
      Pick<
        FlySpriteComputerState,
        "phase" | "message" | "viewerUrl" | "takingControl"
      >
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
  identity: ComputerAgentIdentity = {
    id: process.env.FROCKBOT_AGENT_ID?.trim() || "barebones",
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

export const flySpriteHostPlugin = createFlySpriteHostPlugin(
  new FlySpriteComputer({ respectHumanControl: true }),
);

export default flySpriteHostPlugin;
