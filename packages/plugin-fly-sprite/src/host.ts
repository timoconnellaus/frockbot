import type { Entry } from "@cordisjs/plugin-webui";
import type { ComputerState } from "@frockbot/plugin-computer/shared";
import {
  initialComputerMachineState,
  transitionComputerState,
  type ComputerMachineEvent,
  type ComputerMachineState,
} from "@frockbot/plugin-computer/client-state-machine";
import type { Context, Plugin } from "cordis";
import {
  type ComputerBotIdentity,
  type FlySpriteAgentComputer,
  FlySpriteComputer,
} from "./computer.ts";
import { flySpriteNameForComputer } from "./provider.ts";

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
  private machine: ComputerMachineState;
  private heartbeat?: ReturnType<typeof setInterval>;
  private takingControl = false;

  constructor(
    ctx: Context,
    computer: FlySpriteComputer,
    identity: ComputerBotIdentity,
  ) {
    this.computer = computer.bot(identity);
    this.configured = computer.configured;
    this.machine = transitionComputerState(initialComputerMachineState(), {
      type: "configured",
      botId: this.computer.botId,
      providerLabel: "Fly Sprites",
      configured: computer.configured,
      message: computer.configured
        ? "Persistent Fly Sprite computer"
        : "Set SPRITES_TOKEN to attach a computer",
    });
    const data: ComputerState = {
      ...this.machine,
      connect: () => this.connect(),
      takeControl: () => this.takeOver(),
      releaseControl: () => this.release(),
      runDoctor: () => this.runDoctor(),
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
    this.apply({ type: "connect-requested" });
    try {
      const connection = await this.computer.ensure();
      this.apply({ type: "connected", viewerUrl: connection.viewerUrl });
    } catch (error) {
      this.fail(error);
    }
  }

  private async takeOver(): Promise<void> {
    if (!this.configured || this.takingControl) return;
    if (!this.current().viewerUrl) await this.connect();
    if (!this.current().viewerUrl) return;
    this.apply({ type: "take-control-requested" });
    try {
      await this.computer.takeControl();
      this.takingControl = true;
      this.startHeartbeat();
      this.apply({ type: "control-acquired" });
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
      this.apply({ type: "control-released" });
    } catch (error) {
      this.fail(error);
    }
  }

  /**
   * Runs the Computer's self-check and publishes the report.
   *
   * A failed run is reported as a failed run rather than as a Computer in an
   * error phase: the self-check not answering is a fact about the self-check,
   * and the desktop beside it may be perfectly fine.
   */
  private async runDoctor(): Promise<void> {
    if (!this.configured) return;
    try {
      const report = await this.computer.doctor(new AbortController().signal);
      this.apply({
        type: "doctor-updated",
        doctor: {
          version: 1,
          capturedAt: report.capturedAt,
          summary: report.summary,
          checks: report.checks.map((check) => ({ version: 1, ...check })),
        },
      });
    } catch (error) {
      this.apply({
        type: "doctor-updated",
        doctor: {
          version: 1,
          capturedAt: new Date().toISOString(),
          summary: "the self-check could not be run",
          checks: [
            {
              version: 1,
              name: "self-check",
              status: "fail",
              detail: error instanceof Error ? error.message : String(error),
            },
          ],
        },
      });
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
      this.apply({
        type: "failed",
        message: `Human control lease was lost: ${detail}`,
        takingControl: false,
      });
    }
  }

  private apply(event: ComputerMachineEvent): void {
    this.machine = transitionComputerState(this.machine, event);
    Object.assign(this.data, this.machine);
    this.entry.mutate((data) => Object.assign(data, this.machine));
  }

  private fail(error: unknown): void {
    this.apply({
      type: "failed",
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
          // One Sprite per User (ADR 0012): the Bot is a tenant on it.
          spriteName: flySpriteNameForComputer({ userId: defaultUserId }),
        }),
        {
          id: defaultBotId,
          name: process.env.FROCKBOT_AGENT_NAME?.trim() || "Barebones",
        },
      )
    : () => undefined;

export default flySpriteHostPlugin;
