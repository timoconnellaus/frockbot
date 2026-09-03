// The Package-authoring probe: drives the production authoring flow against
// real workerd storage, a real R2 bucket, the real `BOT_PACKAGES` Worker
// Loader, the real `BotCapabilities` loopback binding, and the real User
// Durable Object quota RPC.
//
// It stands in for the Bot's Durable Object the way `CompositionProbe` does:
// the kernel authority (`BotDurableAuthority`), the authoring host
// (`createPackageAuthoringHost`), the Authoring Package
// (`createAuthoringRuntimePlugin`), the Composition host, and the isolate host
// are all production code. Only the model provider and the bundler transform
// are fixture — see `package-bundler-fake.ts` for why the bundler is.
import { DurableObject } from "cloudflare:workers";
import {
  BotDurableAuthority,
  createStoredRunCodecV1,
  type BotTurnExecutionInput,
} from "@frockbot/kernel-do";
import {
  bootstrapGeneration,
  type CompositionGenerationV1,
} from "@frockbot/kernel-composition/generation";
import type {
  BotIsolateLoader,
  BotIsolateWorkerCode,
} from "@frockbot/kernel-composition/isolate";
import type {
  IsolateConnectionV1,
  IsolateModelBindingV1,
  LlmProvider,
  LlmStreamEvent,
} from "@frockbot/kernel-contracts";
import {
  createPackageAuthoringHost,
  createR2AuthoringArtifactStore,
  readAuthoredCompositionMemberSourceV1,
} from "@frockbot/plugin-shell/backend-authoring";
import { createShellCompositionHost } from "@frockbot/plugin-shell/backend-composition";
import { executeBotTurn } from "@frockbot/plugin-shell/backend-runner";
import {
  BOT_ISOLATE_COMPATIBILITY_DATE,
  createR2PackageArtifactStore,
  isolateBindingDigestV1,
  type BotCapabilitiesPropsV1,
} from "@frockbot/plugin-shell/backend-isolate";
import {
  authorshipFailureKey,
  authorshipManifestKey,
  AUTHORSHIP_FAILURE_PREFIX,
  ARTIFACT_PREFIX,
  createAuthoringRuntimePlugin,
  authoringManifest,
  type AuthoredArtifactRecordV1,
  type AuthoredManifestRecordV1,
  type AuthoringFailureRecordV1,
  type PackageAuthoringHost,
} from "@frockbot/plugin-authoring";
import {
  createPackageCatalogRuntimePlugin,
  packageCatalogManifest,
} from "@frockbot/plugin-package-catalog";
import {
  createPackageCatalogHost,
  createR2BotPackageCatalogReader,
  type CatalogAwarePackageCatalogHost,
} from "@frockbot/plugin-shell/backend-package-catalog";
import {
  decodeOperationReceiptV1,
  decodeUserSettingsViewV1,
} from "@frockbot/configuration-core";
import {
  decodeAuthoringQuotaReceiptV1,
  type AuthoringQuotaBinding,
} from "@frockbot/plugin-authoring/quota";
import type { FoundationAgentPackage } from "@frockbot/agent-runtime/runtime";
import type { Plugin } from "cordis";
import type { BotCapabilities } from "../src/bot-capabilities.ts";
import { createCountingBundlerBinding } from "./package-bundler-fake.ts";
import { twoTierStepV1 } from "./dynamic-tools.ts";

export interface AuthoringProbeEnv {
  BOT_PACKAGES: BotIsolateLoader;
  APPLICATION_ARTIFACTS: R2Bucket;
  PACKAGE_CATALOG: R2Bucket;
  USER_CONFIGURATIONS: DurableObjectNamespace;
}

interface ProbeExports {
  BotCapabilities(options: { props: BotCapabilitiesPropsV1 }): BotCapabilities;
}

/**
 * One scripted Turn: the provider discovers `tool`, calls it through
 * `call_dynamic_tool`, then reports the result. Two round-trips, because
 * that is what ADR 0023 costs a real model — nothing here is reachable by
 * bare name.
 */
export interface AuthoringProbeTurn {
  runId: string;
  userId: string;
  botId: string;
  tool: string;
  input: unknown;
  connections?: IsolateConnectionV1[];
  model?: IsolateModelBindingV1;
}

const PROBE_BOOTSTRAP_AT = "2026-08-31T00:00:00.000Z";

function scriptedProviderPackage(
  tool: string,
  input: unknown,
): FoundationAgentPackage {
  const provider: LlmProvider = {
    id: "scripted",
    async *stream(request): AsyncGenerator<LlmStreamEvent> {
      const step = twoTierStepV1(request, {
        toolName: tool,
        input: input ?? {},
      });
      if (step.kind === "answer") {
        yield {
          type: "text-delta",
          text: `${step.isError ? "error" : "ok"}:${step.content}`,
        };
        yield { type: "finish", reason: "completed" };
        return;
      }
      yield { type: "tool-call", call: step.call };
      yield { type: "finish", reason: "tool-calls" };
    },
  };
  const plugin: Plugin.Function = (ctx) => ctx.llm.register(provider);
  plugin.inject = ["llm"];
  return {
    specifier: "@frockbot/test-scripted-provider",
    contributionSpecifier: "@frockbot/test-scripted-provider/runtime.js",
    manifest: {
      schemaVersion: 3,
      id: "test-scripted-provider",
      displayName: "Scripted provider",
      version: "0.0.1",
      compatibility: { frockbot: "^0.0.1" },
      dependencies: {},
      contributions: { runtime: { entry: "./runtime.js" } },
      permissions: [],
    },
    plugin,
  };
}

function authoringPackage(host: PackageAuthoringHost): FoundationAgentPackage {
  return {
    specifier: "@frockbot/plugin-authoring",
    contributionSpecifier: "@frockbot/plugin-authoring/agent",
    manifest: authoringManifest,
    plugin: createAuthoringRuntimePlugin(host),
  };
}

function catalogPackage(
  host: CatalogAwarePackageCatalogHost,
): FoundationAgentPackage {
  return {
    specifier: "@frockbot/plugin-package-catalog",
    contributionSpecifier: "@frockbot/plugin-package-catalog/agent",
    manifest: packageCatalogManifest,
    plugin: createPackageCatalogRuntimePlugin(host),
  };
}

export class AuthoringProbe extends DurableObject<AuthoringProbeEnv> {
  private readonly authority: BotDurableAuthority<undefined>;
  private turn: AuthoringProbeTurn | undefined;
  private lastPin: string | undefined;
  private loaderCalls = 0;
  private loaderIds: string[] = [];
  private currentToolNames: string[] = [];

  constructor(ctx: DurableObjectState, env: AuthoringProbeEnv) {
    super(ctx, env);
    this.authority = new BotDurableAuthority<undefined>({
      state: ctx,
      codec: createStoredRunCodecV1<undefined>({
        decodeRunId: (value) => value as string,
        decodeConfigurationSnapshot: () => undefined,
      }),
      hooks: {
        resolveAdmissionSnapshot: () => Promise.resolve(undefined),
        bootstrapComposition: () =>
          bootstrapGeneration(
            [
              {
                packageId: "shell",
                specifier: "@frockbot/plugin-shell",
                version: "0.0.1",
                manifest: { id: "shell", version: "0.0.1" },
              },
            ],
            { createdAt: PROBE_BOOTSTRAP_AT },
          ),
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

  private countingLoader(): BotIsolateLoader {
    const loader = this.env.BOT_PACKAGES;
    return {
      get: (id: string, callback: () => Promise<BotIsolateWorkerCode>) => {
        this.loaderCalls += 1;
        this.loaderIds.push(id);
        return loader.get(id, callback);
      },
    };
  }

  /** The narrow User Durable Object quota RPC the Bot object calls. */
  private quota(userId: string): AuthoringQuotaBinding {
    const id = this.env.USER_CONFIGURATIONS.idFromName(userId);
    // SAFETY: this namespace binds UserConfiguration; workers-types cannot
    // infer its generated RPC surface.
    const rpc = this.env.USER_CONFIGURATIONS.get(id) as unknown as {
      reserveAuthoringQuota(input: unknown): Promise<unknown>;
    };
    return {
      reserve: async (request) =>
        decodeAuthoringQuotaReceiptV1(await rpc.reserveAuthoringQuota(request)),
    };
  }

  private authoringHost(turn: AuthoringProbeTurn): PackageAuthoringHost {
    return createPackageAuthoringHost({
      storage: {
        get: (key) => this.ctx.storage.get(key),
        put: (entries) => this.ctx.storage.put(entries),
        list: (options) => this.ctx.storage.list(options),
      },
      composition: this.authority.composition,
      bundler: createCountingBundlerBinding(this.ctx.storage),
      artifacts: createR2AuthoringArtifactStore(this.env.APPLICATION_ARTIFACTS),
      quota: this.quota(turn.userId),
      userId: turn.userId,
      botId: turn.botId,
      runId: turn.runId,
      turnId: turn.runId,
      compatibilityDate: BOT_ISOLATE_COMPATIBILITY_DATE,
      currentToolNames: () => this.currentToolNames,
      activationFailures: this.authority.compositionFailures,
    });
  }

  private catalogHost(
    turn: AuthoringProbeTurn,
  ): CatalogAwarePackageCatalogHost {
    const id = this.env.USER_CONFIGURATIONS.idFromName(turn.userId);
    const rpc = this.env.USER_CONFIGURATIONS.get(id) as unknown as {
      readConfiguration(input: unknown): Promise<unknown>;
      executeConfiguration(input: unknown): Promise<unknown>;
    };
    return createPackageCatalogHost({
      storage: {
        get: (key) => this.ctx.storage.get(key),
        put: (entries) => this.ctx.storage.put(entries),
      },
      composition: this.authority.composition,
      catalog: createR2BotPackageCatalogReader(
        this.env.PACKAGE_CATALOG,
        this.env.APPLICATION_ARTIFACTS,
      ),
      user: {
        read: async () =>
          decodeUserSettingsViewV1(
            await rpc.readConfiguration({
              schemaVersion: 1,
              userId: turn.userId,
            }),
          ),
        execute: async (command) =>
          decodeOperationReceiptV1(
            await rpc.executeConfiguration({
              schemaVersion: 1,
              userId: turn.userId,
              command,
            }),
          ),
      },
      userId: turn.userId,
      botId: turn.botId,
      runId: turn.runId,
      turnId: turn.runId,
    });
  }

  private async executeTurn(input: BotTurnExecutionInput<undefined>) {
    const turn = this.turn;
    if (!turn) throw new Error("the authoring probe has no scripted turn");
    this.lastPin = input.compositionGenerationId;
    const generation = await this.authority.composition.read(
      input.compositionGenerationId,
    );
    if (!generation) {
      throw new Error(
        `run "${input.command.runId}" pins unknown generation "${input.compositionGenerationId}"`,
      );
    }
    // SAFETY: exported WorkerEntrypoints are materialized on ctx.exports;
    // workers-types cannot infer the generated local RPC stubs.
    const exports = this.ctx.exports as unknown as ProbeExports;
    const catalog = this.catalogHost(turn);
    const baseAuthoring = this.authoringHost(turn);
    const authoring: PackageAuthoringHost = {
      ...baseAuthoring,
      undo: async (request) =>
        (await catalog.undoCatalogChange(request)) ??
        baseAuthoring.undo(request),
    };
    const connections = turn.connections ?? [];
    const host = createShellCompositionHost({
      admitEffect: () => Promise.resolve(true),
      botId: turn.botId,
      sessionId: input.command.sessionId,
      sessionEvents: input.previousEvents,
      persistSessionEvents: input.persistSessionEvents,
      agentPackages: [
        scriptedProviderPackage(turn.tool, turn.input),
        authoringPackage(authoring),
        catalogPackage(catalog),
      ],
      modelSelection: { provider: "scripted", model: "scripted-v1" },
      isolate: {
        userId: turn.userId,
        runId: turn.runId,
        turnId: turn.runId,
        loader: this.countingLoader(),
        artifacts: createR2PackageArtifactStore(this.env.APPLICATION_ARTIFACTS),
        manifestFor: async (member) => {
          const stored = await this.ctx.storage.get<AuthoredManifestRecordV1>(
            authorshipManifestKey(member.manifestHash),
          );
          if (!stored) throw new Error("stored authored manifest is missing");
          return stored.manifest;
        },
        capabilitiesFor: (member) =>
          exports.BotCapabilities({
            props: {
              userId: turn.userId,
              botId: turn.botId,
              runId: turn.runId,
              sessionId: input.command.sessionId,
              turnId: turn.runId,
              generationId: generation.generationId,
              packageId: member.packageId,
              connections: structuredClone(connections),
              ...(turn.model ? { model: structuredClone(turn.model) } : {}),
              memory: false,
              workspace: false,
            },
          }),
        bindingDigest: await isolateBindingDigestV1({
          userId: turn.userId,
          botId: turn.botId,
          connections,
          ...(turn.model ? { model: turn.model } : {}),
          compositionGenerationId: generation.generationId,
          runId: turn.runId,
        }),
        compatibilityDate: BOT_ISOLATE_COMPATIBILITY_DATE,
      },
    });
    const controller = new AbortController();
    const composition = await host.mount(generation, controller.signal);
    await composition.verify(controller.signal);
    this.currentToolNames = composition.root.tools.registeredNames?.() ?? [];
    // Activation at the next admitted Turn: the pinned proposal becomes
    // active once it has mounted and verified.
    if (generation.status === "pending") {
      await this.authority.composition.commit(generation.generationId);
    }
    // The production Turn runner, so the durable session log this probe
    // inspects is the one a real Turn writes.
    return await executeBotTurn({
      command: input.command,
      previousEvents: input.previousEvents,
      composition,
      resume: input.resume,
    });
  }

  async runTurn(turn: AuthoringProbeTurn): Promise<{
    text: string;
    pinnedGenerationId: string | undefined;
    loaderCalls: number;
    loaderIds: string[];
  }> {
    this.turn = turn;
    this.loaderCalls = 0;
    this.loaderIds = [];
    const result = await this.authority.run({
      userId: turn.userId,
      botId: turn.botId,
      runId: turn.runId,
      sessionId: `${turn.userId}:${turn.botId}`,
      acceptedAt: new Date().toISOString(),
      text: turn.tool,
    });
    return {
      text: result.text,
      pinnedGenerationId: this.lastPin,
      loaderCalls: this.loaderCalls,
      loaderIds: [...this.loaderIds],
    };
  }

  async bundlerCalls(): Promise<number> {
    return (await this.ctx.storage.get<number>("probe:bundler-calls")) ?? 0;
  }

  async currentGeneration(): Promise<CompositionGenerationV1> {
    return await this.authority.composition.current();
  }

  async lastKnownGoodGeneration(): Promise<CompositionGenerationV1> {
    return await this.authority.composition.lastKnownGood();
  }

  async generation(generationId: string): Promise<CompositionGenerationV1> {
    const generation = await this.authority.composition.read(generationId);
    if (!generation) throw new Error(`generation "${generationId}" is unknown`);
    return generation;
  }

  /** The tools the last mounted Composition actually registered. */
  async mountedToolNames(): Promise<string[]> {
    return [...this.currentToolNames];
  }

  /** The manifest a member was authored with, as the mount reads it. */
  async memberManifest(
    generationId: string,
    packageId: string,
  ): Promise<unknown> {
    const generation = await this.generation(generationId);
    const member = generation.members.find(
      (candidate) => candidate.packageId === packageId,
    );
    if (!member) throw new Error(`no member "${packageId}"`);
    const stored = await this.ctx.storage.get<AuthoredManifestRecordV1>(
      authorshipManifestKey(member.manifestHash),
    );
    if (!stored) throw new Error("stored authored manifest is missing");
    return stored.manifest;
  }

  /** The member as the generation records it, artifact included. */
  async member(
    generationId: string,
    packageId: string,
  ): Promise<CompositionGenerationV1["members"][number] | undefined> {
    const generation = await this.generation(generationId);
    return generation.members.find(
      (candidate) => candidate.packageId === packageId,
    );
  }

  async artifactRecords(): Promise<AuthoredArtifactRecordV1[]> {
    const stored = await this.ctx.storage.list<AuthoredArtifactRecordV1>({
      prefix: ARTIFACT_PREFIX,
    });
    return [...stored.values()];
  }

  async failures(): Promise<AuthoringFailureRecordV1[]> {
    const stored = await this.ctx.storage.list<AuthoringFailureRecordV1>({
      prefix: AUTHORSHIP_FAILURE_PREFIX,
    });
    return [...stored.values()];
  }

  async failure(
    failureId: string,
  ): Promise<AuthoringFailureRecordV1 | undefined> {
    return await this.ctx.storage.get<AuthoringFailureRecordV1>(
      authorshipFailureKey(failureId),
    );
  }

  async sessionEventTypes(): Promise<string[]> {
    const events =
      (await this.ctx.storage.get<{ type: string }[]>("latest-events")) ?? [];
    return events.map((event) => event.type);
  }

  async artifactBytes(contentHash: string): Promise<string | undefined> {
    const object = await this.env.APPLICATION_ARTIFACTS.get(
      `packages/${contentHash}.mjs`,
    );
    return object ? await object.text() : undefined;
  }

  async memberSource(
    generationId: string,
    packageId: string,
  ): Promise<string | undefined> {
    const generation = await this.generation(generationId);
    const member = generation.members.find(
      (candidate) => candidate.packageId === packageId,
    );
    if (!member) return undefined;
    return readAuthoredCompositionMemberSourceV1({
      storage: { get: (key) => this.ctx.storage.get(key) },
      artifacts: createR2AuthoringArtifactStore(this.env.APPLICATION_ARTIFACTS),
      member,
    });
  }
}
