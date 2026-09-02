// The Bot isolate probe: drives the production isolate host, the generated
// wrapper, the real `BOT_PACKAGES` Worker Loader, and the real
// `BotCapabilities` loopback service binding against workerd.
//
// It stands in for the Bot's Durable Object the way `CompositionProbe` stands
// in for the kernel authority: the code under test is production
// (`createShellCompositionHost`, `BotIsolateContributionHost`,
// `BOT_ISOLATE_WRAPPER_SOURCE`, `BotCapabilities`), and only the Turn's
// surrounding configuration is fixture.
import { DurableObject } from "cloudflare:workers";
import type { LlmProvider, LlmStreamEvent } from "@frockbot/kernel-contracts";
import {
  bootstrapGeneration,
  compositionArtifactSetHashV1,
  compositionGenerationIdV1,
  type ArtifactRefV1,
  type CompositionGenerationV1,
  type CompositionMemberV1,
} from "@frockbot/kernel-composition/generation";
import type {
  BotIsolateLoader,
  BotIsolateWorkerCode,
} from "@frockbot/kernel-composition/isolate";
import {
  createShellCompositionHost,
  type ShellMountedComposition,
} from "@frockbot/plugin-shell/backend-composition";
import {
  BOT_ISOLATE_COMPATIBILITY_DATE,
  isolateBindingDigestV1,
  type BotCapabilitiesPropsV1,
} from "@frockbot/plugin-shell/backend-isolate";
import type {
  IsolateConnectionV1,
  IsolateModelBindingV1,
} from "@frockbot/kernel-contracts";
import type { FoundationAgentPackage } from "@frockbot/agent-runtime/runtime";
import type { Plugin } from "cordis";
import type { BotCapabilities } from "../src/bot-capabilities.ts";
import type { WorkerdBotState } from "./fly-compatibility-worker.ts";

export interface BotIsolateProbeEnv {
  BOT_PACKAGES: BotIsolateLoader;
  APPLICATION_ARTIFACTS: R2Bucket;
  BOT_STATES: DurableObjectNamespace<WorkerdBotState>;
  SECRET_TOKEN: string;
}

interface ProbeExports {
  BotCapabilities(options: { props: BotCapabilitiesPropsV1 }): BotCapabilities;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** A hand-seeded Bot Package. No authoring tool exists until Step 5. */
export const PROBE_PACKAGE_SOURCE = `
export const tools = [
  { name: "reverse_text", description: "Reverses text", inputSchema: { type: "object" }, idempotent: true },
  { name: "env_keys", description: "Reports the bindings this isolate can see", inputSchema: {}, idempotent: true },
  { name: "leak_probe", description: "Reports whether host state leaked in", inputSchema: {}, idempotent: true },
  { name: "reach_network", description: "Attempts egress", inputSchema: {}, idempotent: false },
  { name: "call_model", description: "Calls the model binding", inputSchema: {}, idempotent: false },
  { name: "list_capabilities", description: "Lists the Bot's authority", inputSchema: {}, idempotent: true },
  { name: "connection_lease", description: "Requests a lease for one Connection", inputSchema: {}, idempotent: true },
  { name: "schedule_surface", description: "Reports whether durable scheduling is present", inputSchema: {}, idempotent: true },
];

export async function execute(tool, input, ctx) {
  switch (tool) {
    case "reverse_text":
      return String(input?.text ?? "").split("").reverse().join("");
    case "env_keys":
      return JSON.stringify(ctx.bindings);
    case "leak_probe":
      return JSON.stringify({
        packageId: ctx.packageId,
        botId: ctx.botId,
        secret: typeof globalThis.SECRET_TOKEN,
        botStates: typeof globalThis.BOT_STATES,
        loader: typeof globalThis.BOT_PACKAGES,
        storage: typeof ctx.storage,
        env: typeof ctx.env,
        durableObject: typeof globalThis.DurableObject,
      });
    case "reach_network":
      await fetch("https://example.com");
      return "egress-allowed";
    case "list_capabilities":
      return JSON.stringify(await ctx.capabilities.list());
    case "connection_lease":
      return JSON.stringify(await ctx.connection(String(input?.connectionId ?? "")));
    case "schedule_surface":
      return typeof ctx.schedule;
    case "call_model": {
      const outcome = await ctx.model.invoke(input);
      if (outcome.status !== "streaming") return JSON.stringify(outcome);
      let text = "";
      for await (const event of outcome.events) {
        if (event.type === "text-delta") text += event.text;
      }
      return JSON.stringify({ status: "streaming", requestId: outcome.requestId, text });
    }
    default:
      return "unknown tool";
  }
}
`;

/** A deliberate syntax error: `prepare()` must fail with a diagnostic, not hang. */
export const PROBE_BROKEN_SOURCE = `
export const tools = [{ name: "broken", description: "", inputSchema: {} }];
export async function execute(tool, input, ctx) {
  return "never" ;;;
`;

/**
 * A provider that scripts one tool-call turn, so an isolate tool is reached
 * through `ctx.tools` by the Agent loop rather than by the test.
 */
function scriptedProviderPackage(toolName: string): FoundationAgentPackage {
  const provider: LlmProvider = {
    id: "scripted",
    async *stream(request): AsyncGenerator<LlmStreamEvent> {
      const latest = request.messages.at(-1);
      if (latest?.role === "tool") {
        yield { type: "text-delta", text: `tool:${latest.content}` };
        yield { type: "finish", reason: "completed" };
        return;
      }
      const user = request.messages.findLast(
        (message) => message.role === "user",
      );
      yield {
        type: "tool-call",
        call: {
          id: "call-1",
          name: toolName,
          input: { text: user?.role === "user" ? user.content : "" },
        },
      };
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

export class BotIsolateProbe extends DurableObject<BotIsolateProbeEnv> {
  private loaderIds: string[] = [];
  private loadedCode: BotIsolateWorkerCode[] = [];

  /** Counts every `.get()` on the Bot Package loader for this probe. */
  private countingLoader(): BotIsolateLoader {
    const loader = this.env.BOT_PACKAGES;
    const loaderIds = this.loaderIds;
    const loadedCode = this.loadedCode;
    return {
      get(id: string, callback: () => Promise<BotIsolateWorkerCode>) {
        loaderIds.push(id);
        return loader.get(id, async () => {
          const code = await callback();
          loadedCode.push(code);
          return code;
        });
      },
    };
  }

  /**
   * The `WorkerCode` a non-first-party Package is actually loaded with:
   * `globalOutbound`, the env key set, and the limits, with nothing that could
   * carry a secret.
   */
  async observedWorkerCode(input: {
    userId: string;
    botId: string;
    artifact: ArtifactRefV1;
  }): Promise<
    {
      globalOutbound: null;
      envKeys: string[];
      identityKeys: string[];
      limits: { cpuMs: number; subRequests: number };
    }[]
  > {
    this.loadedCode = [];
    const { composition } = await this.mount(input);
    await composition.verify(new AbortController().signal);
    await composition.dispose();
    return this.loadedCode.map((code) => ({
      globalOutbound: code.globalOutbound,
      envKeys: Object.keys(code.env).sort(),
      identityKeys: Object.keys(
        code.env.IDENTITY as Record<string, unknown>,
      ).sort(),
      limits: code.limits,
    }));
  }

  async seedArtifact(source: string): Promise<ArtifactRefV1> {
    const contentHash = await sha256Hex(source);
    await this.env.APPLICATION_ARTIFACTS.put(
      `packages/${contentHash}.mjs`,
      source,
    );
    return {
      contentHash,
      size: source.length,
      mediaType: "application/javascript",
      bundlerVersion: "probe-seed",
    };
  }

  private async generation(
    artifact?: ArtifactRefV1,
    createdAt = "2026-08-31T00:00:00.000Z",
  ): Promise<CompositionGenerationV1> {
    const base = await bootstrapGeneration(
      [
        {
          packageId: "shell",
          specifier: "@frockbot/plugin-shell",
          version: "0.0.1",
          manifest: { id: "shell", version: "0.0.1" },
        },
      ],
      { createdAt },
    );
    if (!artifact) return base;
    const members: CompositionMemberV1[] = [
      ...base.members,
      {
        packageId: "bot-authored",
        specifier: "@bot/authored",
        version: "0.0.1",
        manifestHash: await sha256Hex("bot-authored"),
        provenance: {
          kind: "bot" as const,
          packageId: "bot-authored",
          version: "0.0.1",
          botId: "probe",
          sessionId: "user-1:probe",
          turnId: "turn-1",
          runId: "run-1",
          authoredAt: createdAt,
        },
        artifact,
      },
    ].sort((left, right) => left.packageId.localeCompare(right.packageId));
    const artifactSetHash = await compositionArtifactSetHashV1(members);
    return {
      ...base,
      generationId: compositionGenerationIdV1(createdAt, artifactSetHash),
      createdAt,
      artifactSetHash,
      members,
    };
  }

  private async mount(input: {
    userId: string;
    botId: string;
    artifact?: ArtifactRefV1;
    connections?: IsolateConnectionV1[];
    model?: IsolateModelBindingV1;
    memory?: boolean;
    workspace?: boolean;
    /** Varies the generation without varying the artifact. */
    generationCreatedAt?: string;
  }): Promise<{
    composition: ShellMountedComposition;
    generation: CompositionGenerationV1;
  }> {
    const generation = await this.generation(
      input.artifact,
      input.generationCreatedAt,
    );
    // SAFETY: exported WorkerEntrypoints are materialized on ctx.exports;
    // workers-types cannot infer the generated local RPC stubs.
    const exports = this.ctx.exports as unknown as ProbeExports;
    const composition = await createShellCompositionHost({
      admitEffect: () => Promise.resolve(true),
      botId: input.botId,
      sessionId: `${input.userId}:${input.botId}`,
      sessionEvents: [],
      agentPackages: [scriptedProviderPackage("reverse_text")],
      modelSelection: { provider: "scripted", model: "scripted-v1" },
      isolate: {
        userId: input.userId,
        runId: "run-1",
        turnId: "turn-1",
        loader: this.countingLoader(),
        artifacts: {
          loadPackageArtifact: async (contentHash) => {
            const object = await this.env.APPLICATION_ARTIFACTS.get(
              `packages/${contentHash}.mjs`,
            );
            if (!object) {
              throw new Error(`package artifact "${contentHash}" is missing`);
            }
            const module = await object.text();
            if ((await sha256Hex(module)) !== contentHash) {
              throw new Error(
                `package artifact "${contentHash}" failed hash verification`,
              );
            }
            return module;
          },
        },
        capabilitiesFor: (member) =>
          exports.BotCapabilities({
            props: {
              userId: input.userId,
              botId: input.botId,
              runId: "run-1",
              sessionId: `${input.userId}:${input.botId}`,
              turnId: "turn-1",
              generationId: generation.generationId,
              packageId: member.packageId,
              connections: structuredClone(input.connections ?? []),
              ...(input.model ? { model: structuredClone(input.model) } : {}),
              memory: input.memory ?? false,
              workspace: input.workspace ?? false,
            },
          }),
        bindingDigest: await isolateBindingDigestV1({
          connections: input.connections ?? [],
          ...(input.model ? { model: input.model } : {}),
          compositionGenerationId: generation.generationId,
        }),
        compatibilityDate: BOT_ISOLATE_COMPATIBILITY_DATE,
      },
    }).mount(generation, new AbortController().signal);
    return { composition, generation };
  }

  /** The Composition generation this probe mounts, for the Bot Durable Object to pin. */
  async generationFor(
    artifact?: ArtifactRefV1,
    createdAt?: string,
  ): Promise<CompositionGenerationV1> {
    return await this.generation(artifact, createdAt);
  }

  /** Mounts, verifies, and calls one isolate tool through `ctx.tools`. */
  async callTool(input: {
    userId: string;
    botId: string;
    artifact: ArtifactRefV1;
    tool: string;
    toolInput?: unknown;
    connections?: IsolateConnectionV1[];
    model?: IsolateModelBindingV1;
    memory?: boolean;
    workspace?: boolean;
    generationCreatedAt?: string;
  }): Promise<{ content: string; isError: boolean }> {
    const { composition, generation } = await this.mount(input);
    try {
      await composition.verify(new AbortController().signal);
      const preparation = await composition.root.tools.prepare(
        { id: "call-1", name: input.tool, input: input.toolInput ?? {} },
        {
          botId: input.botId,
          agentId: input.botId,
          sessionId: `${input.userId}:${input.botId}`,
          compositionGenerationId: generation.generationId,
          turnType: "chat" as const,
          effectId: "tool:1:1:0",
          signal: new AbortController().signal,
        },
      );
      if (preparation.kind !== "ready") return preparation.result;
      return await composition.root.tools.executePrepared(preparation, {
        botId: input.botId,
        agentId: input.botId,
        sessionId: `${input.userId}:${input.botId}`,
        compositionGenerationId: generation.generationId,
        turnType: "chat" as const,
        effectId: "tool:1:1:0",
        signal: new AbortController().signal,
      });
    } finally {
      await composition.dispose();
    }
  }

  /** Runs a real Turn; the scripted provider drives the Agent loop into `ctx.tools`. */
  async runTurn(input: {
    userId: string;
    botId: string;
    artifact?: ArtifactRefV1;
    text: string;
  }): Promise<{ text: string; loaderCalls: number }> {
    this.loaderIds = [];
    const { composition } = await this.mount(input);
    try {
      await composition.verify(new AbortController().signal);
      composition.runtime.agent.agent.send(input.text);
      await composition.runtime.agent.agent.whenIdle();
      const message = composition.runtime.agent.agent.session
        .deriveMessages()
        .at(-1);
      return {
        text: message?.role === "assistant" ? message.content : "",
        loaderCalls: this.loaderIds.length,
      };
    } finally {
      await composition.dispose();
    }
  }

  /** Mounts and reports the verification failure rather than throwing it. */
  async verifyFailure(input: {
    userId: string;
    botId: string;
    artifact: ArtifactRefV1;
  }): Promise<string> {
    const { composition } = await this.mount(input);
    try {
      await composition.verify(new AbortController().signal);
      return "";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    } finally {
      await composition.dispose();
    }
  }

  /** The loader ids used by the most recent mount. */
  async observedLoaderIds(input: {
    userId: string;
    botId: string;
    artifact: ArtifactRefV1;
    connections?: IsolateConnectionV1[];
    model?: IsolateModelBindingV1;
    generationCreatedAt?: string;
  }): Promise<string[]> {
    this.loaderIds = [];
    const { composition } = await this.mount(input);
    await composition.dispose();
    return [...this.loaderIds];
  }

  /** Proves the Durable Object still owns storage the isolate cannot see. */
  async writeStorage(value: string): Promise<void> {
    await this.ctx.storage.put("probe", value);
  }

  async readStorage(): Promise<string | undefined> {
    return await this.ctx.storage.get<string>("probe");
  }
}
