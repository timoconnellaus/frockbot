import { DurableObject } from "cloudflare:workers";
import { SpritesClient } from "@fly/sprites";
import { ComputerRegistry } from "@frockbot/computer-core";
import {
  FlySpriteComputer,
  FlySpriteComputerProvider,
} from "@frockbot/plugin-fly-sprite";
import { Context } from "cordis";

interface FlyCompatibilityEnv {
  SPRITES_TOKEN: string;
}

export interface FlyMountResult {
  providerId: string;
  generation: number;
  durableMountCount: number;
}

export interface DurableProbeEvent {
  sequence: number;
  label: string;
}

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
    const durableMountCount =
      ((await this.ctx.storage.get<number>("mount-count")) ?? 0) + 1;
    await this.ctx.storage.put("mount-count", durableMountCount);
    return {
      providerId: assignment.providerId,
      generation: assignment.generation,
      durableMountCount,
    };
  }

  async appendDurableEvent(label: string): Promise<DurableProbeEvent> {
    return this.ctx.storage.transaction(async (transaction) => {
      const sequence =
        ((await transaction.get<number>("event-sequence")) ?? 0) + 1;
      const event = { sequence, label };
      await transaction.put("event-sequence", sequence);
      await transaction.put(
        `event:${sequence.toString().padStart(8, "0")}`,
        event,
      );
      return event;
    });
  }

  async durableEvents(): Promise<DurableProbeEvent[]> {
    const events = await this.ctx.storage.list<DurableProbeEvent>({
      prefix: "event:",
    });
    return [...events.values()];
  }

  async scheduleDurableEvent(label: string): Promise<void> {
    await this.ctx.storage.put("alarm-label", label);
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
  }

  async alarm(): Promise<void> {
    const label = await this.ctx.storage.get<string>("alarm-label");
    if (label === undefined) return;
    await this.appendDurableEvent(label);
    await this.ctx.storage.delete("alarm-label");
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
