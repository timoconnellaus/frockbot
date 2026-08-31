import { DurableObject } from "cloudflare:workers";
import { type SessionEvent } from "@frockbot/kernel-contracts";
import { ComputerRegistry } from "@frockbot/computer-core";
import {
  ComputerHostClient,
  createFlySpriteProviderPlugin,
  FlySpriteComputer,
} from "@frockbot/plugin-fly-sprite";
import { Context } from "cordis";
import {
  BotDurableAuthority,
  createStoredRunCodecV1,
  DurableCompositionStore,
  DurableWorkspaceGenerations,
  DurableWorkspaceSyncEffects,
  type BotTurnExecutionInput,
} from "@frockbot/kernel-do";
import {
  isWorkspaceConflictV1,
  workspaceRootKeyV1,
} from "@frockbot/kernel-contracts";
import type {
  WorkspaceFilesV1,
  WorkspaceGenerationV1,
  WorkspaceGenerationRecordV1,
  WorkspaceRootV1,
  WorkspaceWriteOutcomeV1,
  WorkspaceWriterV1,
} from "@frockbot/kernel-contracts";
import { createDurableWorkspaceFilesV1 } from "../src/workspace.ts";
import { SessionStore } from "@frockbot/kernel-contracts";
import {
  createMemoryWriteTool,
  MemoryProjection,
} from "@frockbot/plugin-memory/agent";
import { createBotMemoryHost } from "@frockbot/plugin-shell/backend-memory";
import {
  createBotPluginSkillsSource,
  createBotSkillCatalogReader,
  createBotSkillsReads,
} from "@frockbot/plugin-shell/backend-skills";
import { loadFullSkillCatalogV1 } from "@frockbot/plugin-skills/catalog";
import { createBotComputerSyncHost } from "@frockbot/plugin-shell/backend-computer";
import {
  createWorkspaceRootSyncV1,
  type ComputerSyncBytesOutcomeV1,
  type ComputerSyncEntryV1,
  type ComputerSyncNoteOutcomeV1,
  type ComputerSyncOutcomeV1,
  type ComputerSyncRemovalV1,
  type ComputerSyncScanOutcomeV1,
  type ComputerSyncSurfaceV1,
} from "@frockbot/plugin-fly-sprite/sync";
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
  /** The shared Computer host (ADR 0004). The provider reaches a Sprite here. */
  COMPUTER_HOST: Fetcher;
  COMPUTER_HOST_TOKEN: string;
}

export interface FlyMountResult {
  providerId: string;
  generation: number;
}

export { BotCapabilities } from "../src/bot-capabilities.ts";
export { BotIsolateProbe } from "./bot-isolate-probe.ts";
export { AuthoringProbe } from "./authoring-probe.ts";
export { SearchSpikeProbe } from "./search-probe.ts";
export { AuditProbe } from "./audit-probe.ts";
export { ComputerHostClientProbe } from "./computer-host-probe.ts";

/**
 * A write outcome flattened for the RPC seam: the fields a test asserts on,
 * as plain strings, so nothing here depends on how the union is narrowed.
 */
export interface WorkspaceProbeOutcome {
  status: string;
  reason?: string;
  generationId?: string;
  currentGenerationId?: string;
  preservedGenerationId?: string;
  preservedConflictsWith?: string;
}

function probeOutcome(outcome: WorkspaceWriteOutcomeV1): WorkspaceProbeOutcome {
  if (outcome.status === "ok") {
    return { status: "ok", generationId: outcome.generation.generationId };
  }
  const conflict = isWorkspaceConflictV1(outcome) ? outcome : undefined;
  return {
    status: outcome.status,
    reason: outcome.reason,
    ...(conflict?.current
      ? { currentGenerationId: conflict.current.generationId }
      : {}),
    ...(conflict?.preserved
      ? {
          preservedGenerationId: conflict.preserved.generationId,
          ...(conflict.preserved.conflictsWith
            ? { preservedConflictsWith: conflict.preserved.conflictsWith }
            : {}),
        }
      : {}),
  };
}

/**
 * One durable-root write, as a workerd test drives it over RPC.
 *
 * `userId` is the User the store is *built for*, not one read off the root:
 * production builds the surface with an `owner` the Durable Object already
 * knows (`bindSurfaces`), and a store built without one would refuse nothing,
 * so a probe that omitted it would prove less than the deployed path does.
 */
export interface WorkspaceProbeWrite {
  userId: string;
  root: WorkspaceRootV1;
  path: string;
  text: string;
  writer: WorkspaceWriterV1;
  expectedGenerationId: string | null;
}

/**
 * The Computer half of the sync, as a probe: a durable map in one Durable
 * Object's storage standing in for a Sprite's filesystem. It is deliberately
 * durable rather than in-memory — the claim under test is that an intent and
 * the Computer-side bytes both survive an eviction, and an in-memory disk
 * would forget the second half.
 */
class ProbeComputerSurface implements ComputerSyncSurfaceV1 {
  static readonly FILE_PREFIX = "probe-computer:file:";
  static readonly REMOVED_PREFIX = "probe-computer:removed:";
  static readonly NOTE_PREFIX = "probe-computer:note:";

  constructor(private readonly ctx: DurableObjectState) {}

  private key(root: WorkspaceRootV1, path: string): string {
    return `${ProbeComputerSurface.FILE_PREFIX}${workspaceRootKeyV1(root)}:${path}`;
  }

  private async hash(bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  /** A file written around the Workspace surface: bytes, and no sidecar. */
  async shellWrite(
    root: WorkspaceRootV1,
    path: string,
    text: string,
  ): Promise<void> {
    await this.ctx.storage.put(this.key(root, path), { text });
  }

  async scan(root: WorkspaceRootV1): Promise<ComputerSyncScanOutcomeV1> {
    const prefix = `${ProbeComputerSurface.FILE_PREFIX}${workspaceRootKeyV1(root)}:`;
    const files = await this.ctx.storage.list<{
      text: string;
      recorded?: WorkspaceGenerationV1;
    }>({ prefix });
    const entries: ComputerSyncEntryV1[] = [];
    for (const [key, value] of files) {
      const bytes = new TextEncoder().encode(value.text);
      entries.push({
        path: key.slice(prefix.length),
        contentHash: await this.hash(bytes),
        size: bytes.byteLength,
        ...(value.recorded ? { recorded: value.recorded } : {}),
      });
    }
    const removals = await this.ctx.storage.list<ComputerSyncRemovalV1>({
      prefix: `${ProbeComputerSurface.REMOVED_PREFIX}${workspaceRootKeyV1(root)}:`,
    });
    return {
      status: "ok",
      scan: { entries, removed: [...removals.values()] },
    };
  }

  async read(
    root: WorkspaceRootV1,
    path: string,
  ): Promise<ComputerSyncBytesOutcomeV1> {
    const stored = await this.ctx.storage.get<{ text: string }>(
      this.key(root, path),
    );
    if (!stored) {
      return { status: "not-found", reason: `no such file: ${path}` };
    }
    return { status: "ok", bytes: new TextEncoder().encode(stored.text) };
  }

  async materialize(
    root: WorkspaceRootV1,
    path: string,
    bytes: Uint8Array,
    generation: WorkspaceGenerationV1,
  ): Promise<ComputerSyncOutcomeV1> {
    await this.ctx.storage.put(this.key(root, path), {
      text: new TextDecoder().decode(bytes),
      recorded: generation,
    });
    return { status: "ok" };
  }

  async remove(
    root: WorkspaceRootV1,
    path: string,
    supersedes: string | undefined,
    tombstone: WorkspaceGenerationV1,
  ): Promise<ComputerSyncOutcomeV1> {
    await this.ctx.storage.delete(this.key(root, path));
    await this.ctx.storage.put(
      `${ProbeComputerSurface.REMOVED_PREFIX}${workspaceRootKeyV1(root)}:${path}`,
      { path, ...(supersedes ? { supersedes } : {}), tombstone },
    );
    return { status: "ok" };
  }

  async forget(
    root: WorkspaceRootV1,
    path: string,
  ): Promise<ComputerSyncOutcomeV1> {
    await this.ctx.storage.delete(
      `${ProbeComputerSurface.REMOVED_PREFIX}${workspaceRootKeyV1(root)}:${path}`,
    );
    return { status: "ok" };
  }

  preserve(): Promise<ComputerSyncOutcomeV1> {
    return Promise.resolve({ status: "ok" });
  }

  async note(
    kind: string,
    id: string,
    text: string,
  ): Promise<ComputerSyncOutcomeV1> {
    await this.ctx.storage.put(
      `${ProbeComputerSurface.NOTE_PREFIX}${kind}:${id}`,
      text,
    );
    return { status: "ok" };
  }

  async readNote(kind: string, id: string): Promise<ComputerSyncNoteOutcomeV1> {
    const text = await this.ctx.storage.get<string>(
      `${ProbeComputerSurface.NOTE_PREFIX}${kind}:${id}`,
    );
    return { status: "ok", ...(text ? { text } : {}) };
  }

  async clearNote(kind: string, id: string): Promise<ComputerSyncOutcomeV1> {
    await this.ctx.storage.delete(
      `${ProbeComputerSurface.NOTE_PREFIX}${kind}:${id}`,
    );
    return { status: "ok" };
  }

  signal(): Promise<ComputerSyncNoteOutcomeV1> {
    return Promise.resolve({ status: "ok" });
  }
}

export class WorkerdBotState extends BotState {
  /**
   * The production Workspace surface this object serves — the same
   * `WORKSPACE_FILES` the Skills seam reads, built over the real R2 bucket and
   * this object's own generation ledger.
   */
  private workspace(owner: { userId: string }): WorkspaceFilesV1 {
    const files = createDurableWorkspaceFilesV1(this.env, {
      owner,
      generations: this.generations(),
    });
    if (!files) throw new Error("no Workspace bucket is bound");
    return files;
  }

  /** The one ledger this object owns; never a second instance. */
  private generations(): DurableWorkspaceGenerations {
    return this.workspaceGenerations;
  }

  async writeWorkspaceFile(
    input: WorkspaceProbeWrite,
  ): Promise<WorkspaceProbeOutcome> {
    return probeOutcome(
      await this.workspace({ userId: input.userId }).write({
        path: { root: input.root, path: input.path },
        bytes: new TextEncoder().encode(input.text),
        writer: input.writer,
        expectedGenerationId: input.expectedGenerationId,
      }),
    );
  }

  async deleteWorkspaceFile(input: {
    userId: string;
    root: WorkspaceRootV1;
    path: string;
    writer: WorkspaceWriterV1;
    expectedGenerationId: string;
  }): Promise<WorkspaceProbeOutcome> {
    return probeOutcome(
      await this.workspace({ userId: input.userId }).delete({
        path: { root: input.root, path: input.path },
        writer: input.writer,
        expectedGenerationId: input.expectedGenerationId,
      }),
    );
  }

  async readWorkspaceFile(input: {
    userId: string;
    root: WorkspaceRootV1;
    path: string;
  }): Promise<{ status: string; text?: string; generationId?: string }> {
    const outcome = await this.workspace({ userId: input.userId }).read({
      root: input.root,
      path: input.path,
    });
    if (outcome.status !== "ok") return { status: outcome.status };
    return {
      status: "ok",
      text: new TextDecoder().decode(outcome.file.bytes),
      generationId: outcome.file.generation.generationId,
    };
  }

  /** Read straight off durable storage, so eviction is what is being tested. */
  async workspaceGeneration(input: {
    root: WorkspaceRootV1;
    path: string;
  }): Promise<WorkspaceGenerationRecordV1 | undefined> {
    return this.generations().current(input.root, input.path);
  }

  async workspaceConflicts(input: {
    root: WorkspaceRootV1;
    path: string;
  }): Promise<WorkspaceGenerationRecordV1[]> {
    return this.generations().conflicts(input.root, input.path);
  }

  /** The preserved bytes of one losing write, read back out of object storage. */
  async workspaceConflictBody(
    conflictKey: string,
  ): Promise<string | undefined> {
    const object = await this.env.MEMORY_FILES.get(conflictKey);
    return object ? object.text() : undefined;
  }

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

  /**
   * Runs the production `memory_write` tool for one identity, inside a real
   * open step, through the Memory host the Durable Object binds.
   *
   * Everything below the tool is production: the Memory surface built in
   * `bindSurfaces`, the routed generation ledger that sends a shared root to
   * the User Durable Object, the conditional write against real R2. Only the
   * caller differs — a probe instead of a model's tool call.
   */
  async memoryWrite(input: {
    userId: string;
    botId: string;
    scope: "bot" | "user" | "project";
    project?: string;
    tier: "profile" | "log" | "note";
    fact: string;
  }): Promise<{ content: string; isError: boolean; events: SessionEvent[] }> {
    this.bindSurfaces({ userId: input.userId, botId: input.botId });
    const host = createBotMemoryHost(
      { userId: input.userId, botId: input.botId },
      {
        runId: "memory-probe-run",
        turnId: "memory-probe-turn",
        sessionId: `${input.userId}:${input.botId}`,
      },
      this.backendEnv,
    );
    if (!host?.writer) throw new Error("no Memory surface is bound");
    const root = new Context();
    await root.plugin(SessionStore);
    const sessionId = `${input.userId}:${input.botId}`;
    const session = root.sessions.create(sessionId);
    session.appendBatch([
      { type: "turn/start", turn: 1 },
      { type: "step/start", turn: 1, step: 1 },
    ]);
    const tool = createMemoryWriteTool(
      { ...host, writer: host.writer },
      root.sessions,
      new MemoryProjection(host),
    );
    const result = await tool.execute(
      {
        scope: input.scope,
        ...(input.project ? { project: input.project } : {}),
        tier: input.tier,
        fact: input.fact,
      },
      {
        botId: input.botId,
        agentId: input.botId,
        sessionId,
        compositionGenerationId: "probe",
        turnType: "chat" as const,
        effectId: "tool:1:1:0",
        signal: new AbortController().signal,
      },
    );
    const events = [...session.events];
    await root.fiber.dispose();
    return { ...result, events };
  }

  /**
   * A write through the *Memory* surface — the production one the Memory
   * Package holds, built in `bindSurfaces` with this Bot's owner and the
   * routed generation ledger. The kernel surface refuses every Memory root
   * outright, so only this surface can show what shard ownership refuses:
   * a Bot writing another Bot's shard of a shared root.
   */
  async memoryWriteWorkspaceFile(
    input: WorkspaceProbeWrite & { botId: string },
  ): Promise<WorkspaceProbeOutcome> {
    this.bindSurfaces({ userId: input.userId, botId: input.botId });
    const files = this.backendEnv.MEMORY_WORKSPACE_FILES;
    if (!files) throw new Error("no Memory Workspace surface is bound");
    return probeOutcome(
      await files.write({
        path: { root: input.root, path: input.path },
        bytes: new TextEncoder().encode(input.text),
        writer: input.writer,
        expectedGenerationId: input.expectedGenerationId,
      }),
    );
  }

  /**
   * One write through each surface this object binds, started together.
   *
   * The two surfaces are built separately — the kernel one over this object's
   * ledger, the Memory one over the routed ledger whose Bot half is the same
   * object — so this is the shape that used to mint one id twice: two ledger
   * instances, each caching its own copy of the minting cursor, both reading
   * it before either wrote it back.
   */
  async mintThroughBothSurfaces(input: {
    userId: string;
    botId: string;
    instructions: WorkspaceRootV1;
    memory: WorkspaceRootV1;
    writer: WorkspaceWriterV1;
  }): Promise<{ kernel?: string; memory?: string }> {
    this.bindSurfaces({ userId: input.userId, botId: input.botId });
    const memory = this.backendEnv.MEMORY_WORKSPACE_FILES;
    if (!memory) throw new Error("no Memory Workspace surface is bound");
    const [first, second] = await Promise.all([
      this.workspace({ userId: input.userId }).write({
        path: { root: input.instructions, path: "notes.md" },
        bytes: new TextEncoder().encode("kernel"),
        writer: input.writer,
        expectedGenerationId: null,
      }),
      memory.write({
        path: { root: input.memory, path: "profile.md" },
        bytes: new TextEncoder().encode("memory"),
        writer: input.writer,
        expectedGenerationId: null,
      }),
    ]);
    return {
      ...(first.status === "ok"
        ? { kernel: first.generation.generationId }
        : {}),
      ...(second.status === "ok"
        ? { memory: second.generation.generationId }
        : {}),
    };
  }

  /** The same surface, reading back what real R2 holds. */
  async memoryReadWorkspaceFile(input: {
    userId: string;
    botId: string;
    root: WorkspaceRootV1;
    path: string;
  }): Promise<{ status: string; text?: string; generationId?: string }> {
    this.bindSurfaces({ userId: input.userId, botId: input.botId });
    const files = this.backendEnv.MEMORY_WORKSPACE_FILES;
    if (!files) throw new Error("no Memory Workspace surface is bound");
    const outcome = await files.read({ root: input.root, path: input.path });
    if (outcome.status !== "ok") return { status: outcome.status };
    return {
      status: "ok",
      text: new TextDecoder().decode(outcome.file.bytes),
      generationId: outcome.file.generation.generationId,
    };
  }

  /** The Bot object's own ledger, to show a shared root is *not* recorded here. */
  async botLedgerGeneration(input: {
    root: WorkspaceRootV1;
    path: string;
  }): Promise<WorkspaceGenerationRecordV1 | undefined> {
    return this.generations().current(input.root, input.path);
  }

  /**
   * The durable-root sync (ADR 0013) with its production halves in place: the
   * object-storage store this object serves, the push intent records this
   * object holds, and its generation ledger. Only the Computer side is a
   * probe — a durable map in this object's own storage standing in for a
   * Sprite's filesystem, so what the "Computer" holds survives eviction the
   * way a Sprite's disk does.
   *
   * `interrupt` drops the connection the way a Sprite pause does: after the
   * store has taken the write but before the sync could settle its intent.
   */
  async computerSyncRun(input: {
    userId: string;
    botId: string;
    interrupt?: boolean;
  }): Promise<{
    status: string;
    pushed: string[];
    pulled: string[];
    adopted: string[];
    failures: string[];
  }> {
    const identity = { userId: input.userId, botId: input.botId };
    this.bindSurfaces(identity);
    const host = createBotComputerSyncHost(this.backendEnv);
    if (!host) throw new Error("no Workspace sync surface is bound");
    const store: WorkspaceFilesV1 = {
      read: (path) => host.store.read(path),
      list: (request) => host.store.list(request),
      stat: (path) => host.store.stat(path),
      write: async (request) => {
        const outcome = await host.store.write(request);
        if (input.interrupt) {
          // The bytes landed; the answer never came back. This is the ordinary
          // shape of a Computer pause, not an exceptional one.
          throw new Error("the connection to the Computer dropped");
        }
        return outcome;
      },
      delete: (request) => host.store.delete(request),
    };
    const sync = createWorkspaceRootSyncV1({
      store,
      computer: new ProbeComputerSurface(this.ctx),
      roots: [
        { kind: "bot-instructions", userId: input.userId, botId: input.botId },
      ],
      ...(host.effects ? { effects: host.effects } : {}),
      ...(host.generations ? { generations: host.generations } : {}),
    });
    const report = await sync.sync();
    const root = report.roots[0];
    return {
      status: report.failures.length > 0 ? "failed" : "ok",
      pushed: root?.pushed ?? [],
      pulled: root?.pulled ?? [],
      adopted: root?.adopted ?? [],
      failures: report.failures.map((failure) => failure.reason),
    };
  }

  /** Writes a file on the probe Computer the way a shell command would. */
  async computerShellWrite(input: {
    root: WorkspaceRootV1;
    path: string;
    text: string;
  }): Promise<void> {
    await new ProbeComputerSurface(this.ctx).shellWrite(
      input.root,
      input.path,
      input.text,
    );
  }

  async computerFile(input: {
    root: WorkspaceRootV1;
    path: string;
  }): Promise<string | undefined> {
    const outcome = await new ProbeComputerSurface(this.ctx).read(
      input.root,
      input.path,
    );
    return outcome.status === "ok"
      ? new TextDecoder().decode(outcome.bytes)
      : undefined;
  }

  /** Push intents this object still holds unsettled, read straight off storage. */
  async pendingSyncEffects(): Promise<
    Array<{ effectId: string; kind: string; path: string }>
  > {
    const effects = await new DurableWorkspaceSyncEffects({
      state: this.ctx,
    }).unsettled();
    return effects.map((effect) => ({
      effectId: effect.effectId,
      kind: effect.kind,
      path: effect.path,
    }));
  }

  /**
   * The production Skill catalog this Bot would inject, assembled inside the
   * Durable Object over the real Workspace bucket, the real Package Catalog
   * bucket, and the User Durable Object's real settings.
   *
   * A probe rather than a Turn because the claim is about the *catalog*: which
   * sources it draws from, at which pinned generations, and what an uninstall
   * removes. The Turn-level claim — that the catalog is injected under the
   * Composition the Turn pinned — is the integration suite's, where a real
   * Turn records `composition/pinned` and `skill/injected` together.
   */
  async skillCatalogProbe(identity: {
    userId: string;
    botId: string;
  }): Promise<{
    compositionGenerationId: string;
    skills: Array<{ ref?: string; path: string; generationId: string }>;
    refusals: Array<{ path: string; reason: string }>;
  }> {
    this.bindSurfaces(identity);
    const reads = createBotSkillsReads(this.backendEnv);
    if (!reads) throw new Error("no Workspace bucket is bound");
    // SAFETY: the generated stub type for `readConfiguration` is too deep for
    // the compiler to instantiate here; this names the one field it reads.
    const configuration = this.env.USER_CONFIGURATIONS.getByName(
      identity.userId,
    ) as unknown as {
      readConfiguration(input: unknown): Promise<{
        packages: Array<{
          packageId: string;
          state: "installed" | "disabled" | "failed";
          catalogId?: string;
          catalogGeneration?: string;
        }>;
      }>;
    };
    const user = await configuration.readConfiguration({
      schemaVersion: 1,
      userId: identity.userId,
    });
    const pluginSkills = createBotPluginSkillsSource(
      user.packages,
      createBotSkillCatalogReader(this.backendEnv),
    );
    const catalog = await loadFullSkillCatalogV1(reads, identity, {
      ...(pluginSkills ? { pluginSkills } : {}),
    });
    const generations = (await this.listCompositionGenerations({
      schemaVersion: 1,
      userId: identity.userId,
      botId: identity.botId,
      query: { limit: 1 },
    })) as { currentGenerationId: string };
    return {
      compositionGenerationId: generations.currentGenerationId,
      skills: catalog.skills.map((skill) => ({
        ...(skill.ref
          ? {
              ref:
                skill.ref.source === "plugin"
                  ? `plugin/${skill.ref.packageId}/${skill.ref.slug}`
                  : `${skill.ref.source}/${skill.ref.slug}`,
            }
          : {}),
        path: skill.path,
        generationId: skill.generationId,
      })),
      refusals: catalog.refusals.map((refusal) => ({
        path: refusal.path,
        reason: `${refusal.kind}: ${refusal.reason}`,
      })),
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

  /** Breaks an already-recorded generation, as a lost artifact would. */
  async breakGeneration(
    generationId: string,
    phase: CompositionFailurePhaseV1,
  ): Promise<void> {
    this.broken.set(generationId, phase);
    return Promise.resolve();
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

  /** The Turn's failure, caught inside the object so no RPC rejection escapes. */
  async runTurnFailure(runId: string): Promise<string> {
    try {
      await this.runTurn(runId);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    return "";
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

/**
 * The Fly provider mounted in workerd, through the shared Computer host.
 *
 * This probe used to prove the opposite: that the provider could reach a
 * Sprite from workerd only far enough to fail on HTTP chunk framing. It no
 * longer can reach one at all — the SDK is on the host now (ADR 0004) — so
 * what is left to prove here is that the provider still mounts behind the
 * provider-neutral Computer interface and opens a Computer over the binding.
 * The live probe it used to carry is retired with the path it probed.
 */
export class FlyCompatibilityProbe extends DurableObject<FlyCompatibilityEnv> {
  private root: Context | undefined;

  private async createRoot(spriteName: string): Promise<Context> {
    const root = new Context();
    try {
      await root.plugin(ComputerRegistry);
      const computer = new FlySpriteComputer({
        spriteName,
        identity: { userId: "workerd" },
        host: (identity, tenant) =>
          new ComputerHostClient({
            fetcher: this.env.COMPUTER_HOST,
            hostToken: this.env.COMPUTER_HOST_TOKEN,
            identity,
            tenant,
          }),
      });
      await root.plugin(createFlySpriteProviderPlugin(computer));
      return root;
    } catch (error) {
      await root.fiber.dispose();
      throw error;
    }
  }

  /**
   * One capture, driven through the provider-neutral Computer interface.
   *
   * The pair is the subject: a guarded `exec` under the tenant's display and a
   * `file/read` that brings the PNG back off the Computer. Only here do both
   * travel the real v1 protocol on a real service binding.
   */
  async screenshot(
    botId = "compatibility",
  ): Promise<
    | { ok: true; display: string; mediaType: string; bytesBase64: string }
    | { ok: false; message: string }
  > {
    this.root ??= await this.createRoot("frockbot-workerd-compatibility");
    const identity = { userId: "workerd" };
    this.root.computers.assign(identity, "fly-sprite");
    const computer = await this.root.computers.open(identity, { botId });
    try {
      const captured = await computer.screenshot!.capture();
      let binary = "";
      for (const byte of captured.bytes) binary += String.fromCharCode(byte);
      return {
        ok: true,
        display: captured.display,
        mediaType: captured.mediaType,
        bytesBase64: btoa(binary),
      };
    } catch (error) {
      // A refusal is answered, not thrown: an RPC rejection crossing the
      // Durable Object boundary is observed twice by the test runner, and the
      // refusal itself is what this probe exists to report.
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      await computer.close();
    }
  }

  /**
   * The Computer's self-check, driven through the provider-neutral interface.
   *
   * What only this layer can show is the exec travelling the real v1 protocol
   * on a real service binding, and the report being decoded at the provider
   * seam rather than handed back as a string for somebody else to parse.
   */
  async doctor(botId = "compatibility"): Promise<
    | {
        ok: true;
        schemaVersion: number;
        generation: number;
        capturedAt: string;
        summary: string;
        checks: { name: string; status: string; detail: string }[];
        browserIdentity?: {
          userAgent: string;
          webdriver: boolean;
          brands: string[];
        };
      }
    | { ok: false; message: string }
  > {
    this.root ??= await this.createRoot("frockbot-workerd-compatibility");
    const identity = { userId: "workerd" };
    this.root.computers.assign(identity, "fly-sprite");
    const computer = await this.root.computers.open(identity, { botId });
    try {
      const report = await computer.doctor!.run();
      return { ok: true, ...report };
    } catch (error) {
      // Answered rather than thrown: an RPC rejection crossing the Durable
      // Object boundary is observed twice by the runner, and the refusal is
      // what this probe exists to report.
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      await computer.close();
    }
  }

  /**
   * A background process, driven through the provider-neutral interface.
   *
   * The probe holds the record the Bot Durable Object would hold, so the
   * reconciliation rule is exercised where it actually runs: launch, check,
   * then a generation bump proving a moved Computer answers `unknown` rather
   * than `running`, then stop.
   */
  async backgroundProcess(input: {
    botId: string;
    command: string;
    action: "launch" | "check" | "stop";
    processId?: string;
  }): Promise<{
    ok: boolean;
    processId?: string;
    pid?: number;
    status?: string;
    exitCode?: number;
    logTail?: string;
    message?: string;
  }> {
    this.root ??= await this.createRoot("frockbot-workerd-compatibility");
    const identity = { userId: "workerd" };
    this.root.computers.assign(identity, "fly-sprite");
    const computer = await this.root.computers.open(identity, {
      botId: input.botId,
    });
    try {
      const processes = computer.processes!;
      if (input.action === "launch") {
        const processId = input.processId ?? "p-probe";
        // Intent before effect, in real Durable Object storage.
        const generation = await processes.generation();
        await this.ctx.storage.put(`process:${processId}`, {
          processId,
          generation,
          status: "starting",
        });
        const launched = await processes.launch({
          processId,
          command: input.command,
        });
        await this.ctx.storage.put(`process:${processId}`, {
          processId,
          generation: launched.generation,
          status: "running",
        });
        return { ok: true, processId, pid: launched.pid };
      }
      const processId = input.processId!;
      const held = (await this.ctx.storage.get(`process:${processId}`)) as
        { generation: number; status: string } | undefined;
      if (!held) return { ok: false, message: "no such process record" };
      const generation = await processes.generation();
      const observed =
        input.action === "stop"
          ? await processes.stop(processId)
          : await processes.inspect(processId);
      const status =
        generation !== held.generation
          ? observed.exitCode === undefined
            ? "unknown"
            : "exited"
          : observed.exitCode !== undefined
            ? "exited"
            : observed.alive
              ? "running"
              : "unknown";
      await this.ctx.storage.put(`process:${processId}`, {
        processId,
        generation: held.generation,
        status,
      });
      return {
        ok: true,
        processId,
        status,
        ...(observed.exitCode === undefined
          ? {}
          : { exitCode: observed.exitCode }),
        logTail: observed.logTail,
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      await computer.close();
    }
  }

  async mountProvider(): Promise<FlyMountResult> {
    this.root ??= await this.createRoot("frockbot-workerd-compatibility");
    const identity = { userId: "workerd" };
    const assignment = this.root.computers.assign(identity, "fly-sprite");
    const computer = await this.root.computers.open(identity, {
      botId: "compatibility",
    });
    await computer.close();
    return {
      providerId: assignment.providerId,
      generation: assignment.generation,
    };
  }
}
