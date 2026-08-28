import { DurableObject } from "cloudflare:workers";
import {
  compileFoundationApplication,
  createFoundationBackendContributions,
} from "@frockbot/application-foundation/runtime";
import type {
  BotStateEnv,
  OwnedBotTurnCommand,
  ShellBotBackendContribution,
} from "@frockbot/plugin-shell/backend";
import { createShellBotBackendContribution } from "@frockbot/plugin-shell/backend";

export type { BotStateEnv, OwnedBotTurnCommand };

export class BotState extends DurableObject<BotStateEnv> {
  private mounted: Promise<ShellBotBackendContribution> | undefined;

  private contribution(): Promise<ShellBotBackendContribution> {
    if (!this.mounted) {
      this.mounted = compileFoundationApplication().then((plan) => {
        const contributions = createFoundationBackendContributions(plan, {
          backendHost: "bot",
          mount: (specifier) => {
            if (specifier !== "@frockbot/plugin-shell/backend") {
              throw new Error(`Unsupported Bot Contribution: ${specifier}`);
            }
            return createShellBotBackendContribution({
              state: this.ctx,
              env: this.env,
            });
          },
        });
        if (contributions.length !== 1) {
          throw new Error("Foundation requires one Bot backend Contribution");
        }
        return contributions[0]!;
      });
    }
    return this.mounted;
  }

  async readConfiguration(input: unknown) {
    return (await this.contribution()).readConfiguration(input);
  }

  async executeConfiguration(input: unknown) {
    return (await this.contribution()).executeConfiguration(input);
  }

  async markConnectionUnavailable(
    ...args: Parameters<
      ShellBotBackendContribution["markConnectionUnavailable"]
    >
  ) {
    return (await this.contribution()).markConnectionUnavailable(...args);
  }

  async resolveConfiguration(
    ...args: Parameters<ShellBotBackendContribution["resolveConfiguration"]>
  ) {
    return (await this.contribution()).resolveConfiguration(...args);
  }

  async run(...args: Parameters<ShellBotBackendContribution["run"]>) {
    return (await this.contribution()).run(...args);
  }

  async reconcileRun(
    ...args: Parameters<ShellBotBackendContribution["reconcileRun"]>
  ) {
    return (await this.contribution()).reconcileRun(...args);
  }

  async listNotifications() {
    return (await this.contribution()).listNotifications();
  }

  async acknowledgeNotification(
    ...args: Parameters<ShellBotBackendContribution["acknowledgeNotification"]>
  ) {
    return (await this.contribution()).acknowledgeNotification(...args);
  }

  async listRuns() {
    return (await this.contribution()).listRuns();
  }

  async alarm(): Promise<void> {
    await (await this.contribution()).alarm();
  }
}
