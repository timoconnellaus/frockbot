import { DurableObject } from "cloudflare:workers";
import { SpritesClient } from "@fly/sprites";
import { type SessionEvent } from "@frockbot/kernel-contracts";
import { ComputerRegistry } from "@frockbot/computer-core";
import {
  createFlySpriteProviderPlugin,
  FlySpriteComputer,
} from "@frockbot/plugin-fly-sprite";
import { Context } from "cordis";
import {
  BotDurableAuthority,
  createStoredRunCodecV1,
  DurableCompositionStore,
  type BotTurnExecutionInput,
} from "@frockbot/kernel-do";
import {
  bootstrapGeneration,
  type CompositionGenerationV1,
  type MountedComposition,
} from "@frockbot/kernel-composition/generation";
import {
  activateCompositionV1,
  CompositionMountFailureError,
  type CompositionFailurePhaseV1,
  type CompositionFailureV1,
} from "@frockbot/kernel-composition/activation";
import { BotState } from "../src/bot-state.ts";
import { BOT_CONFIGURATION_KEY } from "@frockbot/plugin-shell/backend";
import {
  ISOLATE_DECISION_PREFIX,
  ISOLATE_MODEL_REQUEST_PREFIX,
} from "@frockbot/plugin-shell/backend-isolate";
import type { BotSettingsViewV1 } from "@frockbot/configuration-core";
import { UserConfiguration } from "../src/user-configuration.ts";

interface FlyCompatibilityEnv {
  SPRITES_TOKEN: string;
}

export interface FlyMountResult {
  providerId: string;
  generation: number;
}

export { BotCapabilities } from "../src/bot-capabilities.ts";
export { BotIsolateProbe } from "./bot-isolate-probe.ts";
export { AuthoringProbe } from "./authoring-probe.ts";

export class WorkerdBotState extends BotState {
  /** Seeds the durable Bot configuration the isolate capability path reads. */
  async seedBotConfiguration(settings: BotSettingsViewV1): Promise<void> {
    await this.ctx.storage.put(BOT_CONFIGURATION_KEY, settings);
  }

  /** Seeds the Composition generation the isolate model path pins to. */
  async seedCompositionGeneration(
    generation: CompositionGenerationV1,
  ): Promise<void> {
    const store = new DurableCompositionStore({
      state: this.ctx,
      bootstrap: () => Promise.resolve(generation),
    });
    await store.materialize();
  }

  async isolateDecisions(): Promise<unknown[]> {
    const stored = await this.ctx.storage.list<unknown>({
      prefix: ISOLATE_DECISION_PREFIX,
    });
    return [...stored.values()];
  }

  async isolateModelRequestRecords(): Promise<unknown[]> {
    const stored = await this.ctx.storage.list<unknown>({
      prefix: ISOLATE_MODEL_REQUEST_PREFIX,
    });
    return [...stored.values()];
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

const PROBE_BOOTSTRAP_AT = "2026-08-31T00:00:00.000Z";

function probeBootstrap(): Promise<CompositionGenerationV1> {
  return bootstrapGeneration(
    [
      {
        packageId: "shell",
        specifier: "@frockbot/plugin-shell",
        version: "0.0.1",
        manifest: { id: "shell", version: "0.0.1" },
      },
    ],
    { createdAt: PROBE_BOOTSTRAP_AT },
  );
}

/**
 * Exercises the kernel Bot Durable Object Composition records against real
 * workerd storage and eviction, without a model provider.
 */
export class CompositionProbe extends DurableObject {
  private readonly authority: BotDurableAuthority<undefined>;
  private commitDuringTurn: string | undefined;
  private observedPin: string | undefined;
  /** Generations whose mount fails, and the load site they fail at. */
  private readonly broken = new Map<string, CompositionFailurePhaseV1>();
  private observedMount: string | undefined;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    this.authority = new BotDurableAuthority<undefined>({
      state: ctx,
      codec: createStoredRunCodecV1<undefined>({
        decodeRunId: (value) => value as string,
        decodeConfigurationSnapshot: () => undefined,
      }),
      hooks: {
        resolveAdmissionSnapshot: () => Promise.resolve(undefined),
        bootstrapComposition: () => probeBootstrap(),
        admittedSnapshot: () => Promise.resolve(undefined),
        executeTurn: (input) => this.executeTurn(input),
        notification: () => undefined,
        scheduledDeadlines: () => Promise.resolve([]),
        scheduledWorkInFlight: () => false,
        deferScheduledWork: () => Promise.resolve(),
        settleScheduledWork: () => Promise.resolve(),
      },
    });
  }

  private get store(): DurableCompositionStore {
    return this.authority.composition;
  }

  private mounted(generation: CompositionGenerationV1): MountedComposition {
    return {
      generation,
      root: undefined as never,
      verify: () => Promise.resolve(),
      dispose: () => Promise.resolve(),
    };
  }

  private async executeTurn(input: BotTurnExecutionInput<undefined>) {
    this.observedPin = input.compositionGenerationId;
    if (this.commitDuringTurn) {
      const generationId = this.commitDuringTurn;
      this.commitDuringTurn = undefined;
      await this.proposeGeneration(generationId);
      await this.store.commit(await this.generationIdFor(generationId));
      this.observedMount = input.compositionGenerationId;
      return { runId: input.command.runId, text: "ok", events: [] };
    }
    // The production activation algorithm, against real workerd storage.
    const activation = await activateCompositionV1({
      generationId: input.compositionGenerationId,
      store: {
        read: (generationId) => this.store.read(generationId),
        lastKnownGood: () => this.store.lastKnownGood(),
        commit: (generationId) => this.store.commit(generationId),
        fail: (generationId, options) => this.store.fail(generationId, options),
      },
      failures: this.authority.compositionFailures,
      host: {
        mount: (generation) => {
          const phase = this.broken.get(generation.generationId);
          return phase
            ? Promise.reject(
                new CompositionMountFailureError(
                  phase,
                  `generation "${generation.generationId}" failed at ${phase}`,
                  [`${phase}: probe diagnostic`],
                ),
              )
            : Promise.resolve(this.mounted(generation));
        },
      },
      signal: new AbortController().signal,
      onFailure: (failure, fallback) =>
        this.authority.recordNotification({
          notificationId: `composition-failure:${failure.generationId}:${failure.attempt}`,
          runId: input.command.runId,
          createdAt: failure.at,
          title: "Composition failed to activate",
          body: `${failure.phase}: ${failure.message} — running ${fallback.generationId}`,
        }),
    });
    if (activation.status === "failed-closed") {
      await this.authority.repinRun(
        input.command.runId,
        activation.fallback.generationId,
      );
    }
    this.observedMount = activation.mounted.generation.generationId;
    return { runId: input.command.runId, text: "ok", events: [] };
  }

  /** Proposes a generation that is pinned for the next Turn and will not mount. */
  async proposeBrokenGeneration(
    createdAt: string,
    phase: CompositionFailurePhaseV1,
  ): Promise<string> {
    const parent = await this.store.current();
    const generationId = await this.generationIdFor(createdAt);
    await this.store.propose(
      {
        ...parent,
        generationId,
        parentGenerationId: parent.generationId,
        createdAt,
        origin: {
          kind: "bot-authored",
          runId: "author-1",
          sessionId: "user-1:probe",
          turnId: "author-1",
        },
        status: "pending",
      },
      { pin: true },
    );
    this.broken.set(generationId, phase);
    return generationId;
  }

  /** Re-pins a generation the way a Bot authoring another one would. */
  async repinGeneration(generationId: string): Promise<void> {
    const generation = await this.store.read(generationId);
    if (!generation) throw new Error(`unknown generation "${generationId}"`);
    await this.ctx.storage.put("composition:current", {
      generationId: generation.generationId,
      artifactSetHash: generation.artifactSetHash,
    });
  }

  /** Lets a previously broken generation mount, as a repaired artifact would. */
  async repairGeneration(generationId: string): Promise<void> {
    this.broken.delete(generationId);
  }

  async mountedGenerationId(): Promise<string | undefined> {
    return Promise.resolve(this.observedMount);
  }

  async compositionFailures(
    generationId: string,
  ): Promise<CompositionFailureV1[]> {
    return this.authority.compositionFailures.list(generationId);
  }

  async compositionQuarantine(generationId: string): Promise<unknown> {
    return this.authority.compositionFailures.quarantine(generationId);
  }

  async visibleFailures(): Promise<{ notificationId: string; body: string }[]> {
    return (await this.authority.listNotifications()).map((notification) => ({
      notificationId: notification.notificationId,
      body: notification.body,
    }));
  }

  private async generationIdFor(createdAt: string): Promise<string> {
    const parent = await this.store.lastKnownGood();
    return `${createdAt}:${parent.artifactSetHash.slice(0, 16)}`;
  }

  async proposeGeneration(createdAt: string): Promise<string> {
    const parent = await this.store.current();
    const generationId = await this.generationIdFor(createdAt);
    await this.store.propose({
      ...parent,
      generationId,
      parentGenerationId: parent.generationId,
      createdAt,
      origin: { kind: "user-install", userId: "user-1" },
      status: "pending",
    });
    return generationId;
  }

  async commitGeneration(generationId: string): Promise<void> {
    await this.store.commit(generationId);
  }

  /** Reverting is itself a recorded generation, pending until it is committed. */
  async revertGeneration(toGenerationId: string): Promise<string> {
    const reverted = await this.store.revert(toGenerationId, {
      kind: "revert",
      revertsTo: toGenerationId,
      userId: "user-1",
    });
    return reverted.generationId;
  }

  /** The refusal message, caught inside the object so no RPC rejection escapes. */
  async revertRefusal(toGenerationId: string): Promise<string> {
    try {
      await this.revertGeneration(toGenerationId);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    return "";
  }

  async generationStatus(generationId: string): Promise<string | undefined> {
    return (await this.store.read(generationId))?.status;
  }

  async commitDuringNextTurn(createdAt: string): Promise<void> {
    this.commitDuringTurn = createdAt;
  }

  async runTurn(runId: string): Promise<{ pinned: string | undefined }> {
    await this.authority.run({
      userId: "user-1",
      botId: "probe",
      runId,
      sessionId: "user-1:probe",
      acceptedAt: new Date().toISOString(),
      text: runId,
    });
    return { pinned: this.observedPin };
  }

  async storedPin(runId: string): Promise<string | undefined> {
    return (await this.authority.readRun(runId))?.compositionGenerationId;
  }

  async currentGenerationId(): Promise<string> {
    return (await this.store.current()).generationId;
  }

  async listGenerations(query: {
    limit: number;
    cursor?: string;
  }): Promise<{ generationIds: string[]; cursor?: string }> {
    const page = await this.store.list(query);
    return {
      generationIds: page.generations.map((entry) => entry.generationId),
      ...(page.cursor ? { cursor: page.cursor } : {}),
    };
  }
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
      await root.plugin(createFlySpriteProviderPlugin(computer));
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
