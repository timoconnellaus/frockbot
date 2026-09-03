import type { Entry } from "@cordisjs/plugin-webui";
import {
  COMPUTER_UNCONFIGURED_MESSAGE_V1,
  ComputerError,
} from "@frockbot/computer-core";
import type { ComputerState } from "@frockbot/plugin-computer/shared";
import { computerUpdateLabelV1 } from "@frockbot/plugin-computer/protocol";
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
  private controlHeartbeat?: ReturnType<typeof setInterval>;
  private viewerHeartbeat?: ReturnType<typeof setInterval>;
  private viewerSessionId?: string;
  private controlRequest?: Promise<void>;
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
      providerLabel: "Computer",
      configured: computer.configured,
      message: computer.configured
        ? "Computer ready"
        : COMPUTER_UNCONFIGURED_MESSAGE_V1,
    });
    const data: ComputerState = {
      ...this.machine,
      connect: () => this.connect(),
      openViewer: () => this.openViewer(),
      closeViewer: () => this.closeViewer(),
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
    this.stopControlHeartbeat();
    this.stopViewerHeartbeat();
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
      const connection = await this.computer.connect();
      this.viewerSessionId = connection.viewerSessionId;
      this.apply({ type: "connected", viewerUrl: connection.viewerUrl });
      const updateLabel = computerUpdateLabelV1(connection.message);
      if (updateLabel) {
        this.apply({ type: "update-reported", message: updateLabel });
      }
    } catch (error) {
      this.fail(error);
    }
  }

  private async openViewer(): Promise<void> {
    if (this.machine.expanded) return;
    const wake = this.machine.phase === "idle";
    this.apply({ type: "viewer-expanded" });
    if (wake) await this.connect();
  }

  private async closeViewer(): Promise<void> {
    if (!this.machine.expanded) return;
    if (this.controlRequest) {
      try {
        await this.controlRequest;
      } catch {
        // The acquisition failure is already the visible machine state.
      }
    }
    if (this.takingControl) await this.release();
    this.apply({ type: "viewer-collapsed" });
  }

  private takeOver(): Promise<void> {
    if (this.controlRequest) return this.controlRequest;
    const pending = this.acquireControl();
    this.controlRequest = pending.finally(() => {
      this.controlRequest = undefined;
    });
    return this.controlRequest;
  }

  private async acquireControl(): Promise<void> {
    if (!this.configured || this.takingControl) return;
    if (!this.current().viewerUrl) await this.connect();
    if (!this.current().viewerUrl) return;
    this.apply({ type: "take-control-requested" });
    try {
      await this.computer.takeControl();
      this.takingControl = true;
      this.startControlHeartbeat();
      this.apply({ type: "control-acquired" });
    } catch (error) {
      this.fail(error);
    }
  }

  private async release(): Promise<void> {
    if (!this.takingControl) return;
    try {
      await this.computer.releaseControl();
      this.stopControlHeartbeat();
      this.takingControl = false;
      this.apply({ type: "control-released" });
    } catch (error) {
      this.fail(error);
      throw error;
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

  private startControlHeartbeat(): void {
    this.stopControlHeartbeat();
    this.controlHeartbeat = setInterval(
      () => void this.refreshControl(),
      30_000,
    );
  }

  private stopControlHeartbeat(): void {
    if (this.controlHeartbeat) clearInterval(this.controlHeartbeat);
    this.controlHeartbeat = undefined;
  }

  private syncViewerHeartbeat(): void {
    if (!this.machine.expanded || !this.viewerSessionId) {
      this.stopViewerHeartbeat();
      return;
    }
    if (!this.viewerHeartbeat) {
      this.viewerHeartbeat = setInterval(
        () => void this.refreshViewer(),
        30_000,
      );
    }
  }

  private stopViewerHeartbeat(): void {
    if (this.viewerHeartbeat) clearInterval(this.viewerHeartbeat);
    this.viewerHeartbeat = undefined;
  }

  private async refreshViewer(): Promise<void> {
    const sessionId = this.viewerSessionId;
    if (!sessionId) return;
    try {
      await this.computer.refreshViewer(sessionId);
      const viewerUrl = this.current().viewerUrl;
      if (this.machine.phase === "updating" && viewerUrl) {
        this.apply({ type: "connected", viewerUrl });
      }
    } catch (error) {
      this.viewerSessionId = undefined;
      const detail = error instanceof Error ? error.message : String(error);
      this.apply({
        type: "viewer-disconnected",
        message: `Viewer disconnected: ${detail}`,
      });
    }
  }

  private async refreshControl(): Promise<void> {
    try {
      await this.computer.refreshControl();
    } catch (error) {
      this.stopControlHeartbeat();
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
    this.syncViewerHeartbeat();
  }

  private fail(error: unknown): void {
    if (error instanceof ComputerError && error.code === "updating") {
      this.apply({
        type: "update-reported",
        message: computerUpdateLabelV1(error.message) ?? error.message,
      });
      return;
    }
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
