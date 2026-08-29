import { DurableObject } from "cloudflare:workers";
import { SpritesClient } from "@fly/sprites";
import type { SessionEvent } from "@frockbot/agent-core";
import { ComputerRegistry } from "@frockbot/computer-core";
import {
  FlySpriteComputer,
  FlySpriteComputerProvider,
} from "@frockbot/plugin-fly-sprite";
import { Context } from "cordis";
import { BotState } from "../src/bot-state.ts";
import { UserConfiguration } from "../src/user-configuration.ts";

interface FlyCompatibilityEnv {
  SPRITES_TOKEN: string;
}

export interface FlyMountResult {
  providerId: string;
  generation: number;
}

export class WorkerdBotState extends BotState {
  private readonly residencyId = crypto.randomUUID();
  private mountRecorded = false;

  async inspectMountedBot(input: unknown) {
    const settings = await super.readConfiguration(input);
    if (!this.mountRecorded) {
      await this.ctx.storage.transaction(async (transaction) => {
        const mountCount =
          ((await transaction.get<number>("workerd:mount-count")) ?? 0) + 1;
        await transaction.put("workerd:mount-count", mountCount);
      });
      this.mountRecorded = true;
    }
    return {
      residencyId: this.residencyId,
      mountCount: await this.ctx.storage.get<number>("workerd:mount-count"),
      settings,
    };
  }

  async durableSessionEvents(): Promise<SessionEvent[]> {
    return (await this.ctx.storage.get<SessionEvent[]>("latest-events")) ?? [];
  }

  async scheduleRecoveryProbe(): Promise<void> {
    await this.ctx.storage.put("active-run", "missing-run");
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
  }

  async recoveryProbe() {
    return {
      activeRunId: await this.ctx.storage.get<string>("active-run"),
      alarmScheduled: (await this.ctx.storage.getAlarm()) !== null,
    };
  }
}

export { UserConfiguration };

export class FlyCompatibilityProbe extends DurableObject<FlyCompatibilityEnv> {
  private root: Context | undefined;

  private async createRoot(spriteName: string): Promise<Context> {
    const root = new Context();
    try {
      await root.plugin(ComputerRegistry);
      const computer = new FlySpriteComputer({
        spriteName,
        token: this.env.SPRITES_TOKEN || undefined,
      });
      const provider = new FlySpriteComputerProvider(computer);
      const plugin = (ctx: Context) => ctx.computers.register(provider);
      plugin.inject = ["computers"];
      await root.plugin(plugin);
      return root;
    } catch (error) {
      await root.fiber.dispose();
      throw error;
    }
  }

  async mountProvider(): Promise<FlyMountResult> {
    this.root ??= await this.createRoot("frockbot-workerd-compatibility");
    const target = { userId: "workerd", botId: "compatibility" };
    const assignment = this.root.computers.assign(target, "fly-sprite");
    const computer = await this.root.computers.open(target);
    await computer.close();
    return {
      providerId: assignment.providerId,
      generation: assignment.generation,
    };
  }

  async deleteLiveSprite(spriteName: string): Promise<void> {
    if (!this.env.SPRITES_TOKEN) return;
    const client = new SpritesClient(this.env.SPRITES_TOKEN);
    const sprites = await client.listAllSprites(spriteName);
    if (sprites.some((sprite) => sprite.name === spriteName)) {
      await client.deleteSprite(spriteName);
    }
  }

  async probeLiveWorkspace(spriteName: string, text: string): Promise<void> {
    if (!this.env.SPRITES_TOKEN) {
      throw new Error("SPRITES_TOKEN is required for the live Fly test");
    }
    const root = await this.createRoot(spriteName);
    try {
      const target = { userId: "workerd-live", botId: spriteName };
      root.computers.assign(target, "fly-sprite");
      const computer = await root.computers.open(target);
      try {
        if (!computer.exec || !computer.workspace) {
          throw new Error("Fly provider did not expose exec and workspace");
        }
        const result = await computer.exec.execute({
          executable: "/bin/echo",
          args: [text],
          timeoutMs: 10 * 60_000,
          maxOutputBytes: 10_000,
        });
        if (result.exitCode !== 0) {
          throw new Error(`Fly echo exited with ${result.exitCode}`);
        }
        const directory = await computer.workspace.openDirectory({
          namespace: "live-smoke",
          scope: "bot",
          durability: "durable",
        });
        await directory.writeFile("probe.txt", new TextEncoder().encode(text));
        await directory.readFile("probe.txt");
      } finally {
        await computer.close();
      }
    } finally {
      await root.fiber.dispose();
    }
  }
}
