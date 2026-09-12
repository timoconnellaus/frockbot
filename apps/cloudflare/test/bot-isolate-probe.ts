// The Bot isolate probe: drives the production isolate host, the generated
// wrapper, the real `BOT_PACKAGES` Worker Loader, and the real
// `BotCapabilities` loopback service binding against workerd.
//
// It stands in for the Bot's Durable Object the way `CompositionProbe` stands
// in for the kernel authority: the code under test is production
// (`createShellCompositionHost`, `PluginWorkerHost`, the generated index,
// `BotCapabilities`), and only the Turn's
// surrounding configuration is fixture.
import { DurableObject } from "cloudflare:workers";
import { decodePluginDescriptorV1 } from "@frockbot/core/contracts";
import type {
  LlmProvider,
  LlmStreamEvent,
  NormalizedModelRequest,
  SessionEvent,
} from "@frockbot/core/contracts";
import {
  bootstrapGeneration,
  compositionArtifactSetHashV1,
  compositionGenerationIdV1,
  type ArtifactRefV1,
  type CompositionGenerationV1,
  type CompositionMemberV1,
} from "@frockbot/core/durable";
import {
  PluginWorkerHost,
  type BotIsolateLoader,
  type BotIsolateWorkerCode,
} from "@frockbot/frock-compose";
import {
  createShellCompositionHost,
  type ShellMountedComposition,
} from "@frockbot/app/shell/backend-composition";
import {
  BOT_ISOLATE_COMPATIBILITY_DATE,
  isolateBindingDigestV1,
  type BotCapabilitiesPropsV1,
} from "@frockbot/app/isolates/capabilities";
import type {
  IsolateConnectionV1,
  IsolateModelBindingV1,
  PluginWorkerTriggerResultV1,
} from "@frockbot/core/contracts";
import type { FoundationAgentPackage } from "@frockbot/app/agent-runtime";
import type { BotCapabilities } from "../src/bot-capabilities.ts";
import type { WorkerdBotState } from "./computer-compatibility-worker.ts";
import { dynamicToolCallV1, twoTierStepV1 } from "./dynamic-tools.ts";

/**
 * The Package id this probe's isolate mounts under, which is therefore also
 * the namespace its tools are disclosed in. Non-first-party namespaces are
 * external, so a call into one carries `mcpDetails.description`.
 */
export const PROBE_PACKAGE_ID = "bot-authored";

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

const PROBE_HOOK_BODY = `return [...payload.tools, {
    name: "hook_marker",
    description: "Added by the Bot-authored hook for this step",
    inputSchema: { type: "object" },
  }];`;

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
  { name: "context_keys", description: "Lists the generated narrow context keys", inputSchema: {}, idempotent: true },
];

export const hooks = {
  "agent/tool-exposure": async function (payload, ctx) {
    if (ctx.event !== "agent/tool-exposure" || ctx.tool !== undefined) {
      throw new Error("hook received the wrong narrowed context");
    }
    if (payload.step.step !== 1) return undefined;
    ${PROBE_HOOK_BODY}
  },
};

export async function execute(tool, input, ctx) {
  switch (tool) {
    case "reverse_text":
      return String(input?.text ?? "").split("").reverse().join("");
    case "env_keys":
      return JSON.stringify(ctx.bindings);
    case "leak_probe":
      return JSON.stringify({
        packageId: ctx.packageId,
        botId: ctx.bot.botId,
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
    case "context_keys":
      return JSON.stringify(Object.keys(ctx).sort());
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

export const PROBE_THROWING_HOOK_SOURCE = PROBE_PACKAGE_SOURCE.replace(
  PROBE_HOOK_BODY,
  `throw new Error("probe hook exploded");`,
);

export const PROBE_TIMEOUT_HOOK_SOURCE = PROBE_PACKAGE_SOURCE.replace(
  PROBE_HOOK_BODY,
  `await new Promise(function () {});`,
);

export const PROBE_UNDECODABLE_HOOK_SOURCE = PROBE_PACKAGE_SOURCE.replace(
  PROBE_HOOK_BODY,
  `return [{
    name: "not_exact",
    description: "Carries an executable field across a schema-only seam",
    inputSchema: {},
    execute: "undeclared",
  }];`,
);

/**
 * The sixth hook, as a Bot-authored plugin sees it: `agent/request` is handed
 * the step it is shaping (turn and step, like `agent/tool-exposure`) and the
 * request the Bot's authority resolved. Shaping the system prompt is the
 * plugin's to do.
 */
export const PROBE_REQUEST_HOOK_SOURCE = PROBE_PACKAGE_SOURCE.replace(
  `export const hooks = {`,
  `export const hooks = {
  "agent/request": async function (payload, ctx) {
    if (ctx.event !== "agent/request" || ctx.tool !== undefined) {
      throw new Error("hook received the wrong narrowed context");
    }
    return Object.assign({}, payload.request, {
      system:
        payload.request.system +
        "\\n[shaped by the plugin at turn " +
        payload.step.turn +
        " step " +
        payload.step.step +
        "]",
    });
  },`,
);

/**
 * The same hook, redirecting the request at the one field that names which
 * Connection's credential the lease hangs off. The loop must refuse it.
 */
export const PROBE_REQUEST_REDIRECT_HOOK_SOURCE = PROBE_PACKAGE_SOURCE.replace(
  `export const hooks = {`,
  `export const hooks = {
  "agent/request": async function (payload) {
    return Object.assign({}, payload.request, {
      modelBinding: {
        connectionId: "smuggled-connection",
        connectionGeneration: "1",
      },
    });
  },`,
);

/** The hooks a source declares, which the descriptor must name exactly. */
export const PROBE_REQUEST_HOOKS = ["agent/tool-exposure", "agent/request"];

function probePackageDescriptor(hooks: string[]) {
  return decodePluginDescriptorV1({
    id: PROBE_PACKAGE_ID,
    displayName: "Bot authored probe",
    version: "0.0.1",
    tools: [
      "reverse_text",
      "env_keys",
      "leak_probe",
      "reach_network",
      "call_model",
      "list_capabilities",
      "connection_lease",
      "schedule_surface",
      "context_keys",
    ].map((name) => ({ name, description: name, inputSchema: {} })),
    contractVersion: 3,
    hooks,
    grants: ["ai", "http", "schedule", "memory", "workspace"],
    // The probe's `reach_network` tool proves egress is refused whatever the
    // descriptor declares: `globalOutbound` is null and no egress stub exists
    // yet.
    network: { hosts: ["example.com"] },
    contextKeys: ["user", "bot", "session"],
  });
}

/**
 * Two Plugins that only make sense together: the provider exports a service
 * and a prompt hook, the consumer reads the service in a tool and wraps the
 * same hook after the provider, so a Turn proves mount order, services and
 * the chain inside one worker.
 */
export const PROBE_PROVIDER_ID = "probe-provider";
export const PROBE_CONSUMER_ID = "probe-consumer";

export const PROBE_PROVIDER_SOURCE = `
export const tools = [
  { name: "provider_ping", description: "Answers", inputSchema: {}, idempotent: true },
];
export const services = { "greeting": { word: "hello" } };
export const hooks = {
  "agent/tool-exposure": async function (payload) {
    return [...payload.tools, { name: "from_provider", description: "", inputSchema: {} }];
  },
};
export async function execute(tool) {
  return tool === "provider_ping" ? "pong" : "unknown tool";
}
`;

export const PROBE_CONSUMER_SOURCE = `
export const tools = [
  { name: "read_service", description: "Reads the provider's service", inputSchema: {}, idempotent: true },
];
export const hooks = {
  "agent/tool-exposure": async function (payload) {
    return [...payload.tools, { name: "from_consumer", description: "", inputSchema: {} }];
  },
};
export async function execute(tool, input, ctx) {
  if (tool !== "read_service") return "unknown tool";
  return JSON.stringify({ services: Object.keys(ctx.services), word: ctx.services.greeting.word, packageId: ctx.packageId });
}
`;

const PROBE_PROVIDER_DESCRIPTOR = decodePluginDescriptorV1({
  id: PROBE_PROVIDER_ID,
  displayName: "Probe provider",
  version: "0.0.1",
  tools: [{ name: "provider_ping", description: "Answers", inputSchema: {} }],
  contractVersion: 4,
  hooks: ["agent/tool-exposure"],
  grants: [],
  provides: [{ name: "greeting", version: 1 }],
  contextKeys: ["user", "bot", "session"],
});

const PROBE_CONSUMER_DESCRIPTOR = decodePluginDescriptorV1({
  id: PROBE_CONSUMER_ID,
  displayName: "Probe consumer",
  version: "0.0.1",
  tools: [
    {
      name: "read_service",
      description: "Reads the provider's service",
      inputSchema: {},
    },
  ],
  contractVersion: 4,
  hooks: ["agent/tool-exposure"],
  grants: [],
  consumes: [{ name: "greeting", version: 1 }],
  contextKeys: ["user", "bot", "session"],
});

/**
 * A Plugin that exports `triggers`, the contract-4 surface an app-owned
 * delivery reaches. One trigger per answer the kernel has to tell apart: a
 * body it fires on, a refusal it authored, a silent return, one that never
 * answers, and one whose text is small in UTF-16 units but far over the
 * contract's byte bound.
 */
export const PROBE_TRIGGER_ID = "probe-trigger";

export const PROBE_TRIGGER_SOURCE = `
export const tools = [
  { name: "trigger_noop", description: "Does nothing", inputSchema: {}, idempotent: true },
];
export const triggers = {
  "inbound": async function (delivery, ctx) {
    return JSON.stringify({
      packageId: ctx.packageId,
      botId: ctx.bot.botId,
      sessionId: ctx.session.sessionId,
      signature: delivery.headers["x-probe-signature"],
      city: JSON.parse(delivery.body).city,
    });
  },
  "refuse": async function () {
    return { drop: true, reason: "nothing in this delivery is for me" };
  },
  "silent": async function () {
    return undefined;
  },
  "wedged": async function () {
    await new Promise(function () {});
  },
  // 300,000 astral code points: 600,000 UTF-16 units, under the bound if it
  // were counted in units, and 1.2 MB once encoded as the bytes it arrives as.
  "oversized": async function () {
    return "\u{1F600}".repeat(300000);
  },
};
export async function execute(tool) {
  return tool === "trigger_noop" ? "ok" : "unknown tool";
}
`;

const PROBE_TRIGGER_DESCRIPTOR = decodePluginDescriptorV1({
  id: PROBE_TRIGGER_ID,
  displayName: "Probe trigger",
  version: "0.0.1",
  tools: [
    { name: "trigger_noop", description: "Does nothing", inputSchema: {} },
  ],
  contractVersion: 4,
  hooks: [],
  grants: [],
  // The descriptor names every trigger the module exports: a report that
  // differs is a health failure, so this pair is what makes the module mount.
  triggers: ["inbound", "refuse", "silent", "wedged", "oversized"].map(
    (name) => ({ name, description: name }),
  ),
  contextKeys: ["user", "bot", "session"],
});

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
function scriptedProviderPackage(
  toolName: string,
  requests: NormalizedModelRequest[],
): FoundationAgentPackage {
  const provider: LlmProvider = {
    id: "scripted",
    async *stream(request): AsyncGenerator<LlmStreamEvent> {
      requests.push(structuredClone(request));
      const user = request.messages.findLast(
        (message) => message.role === "user",
      );
      const step = twoTierStepV1(request, {
        toolName,
        input: { text: user?.role === "user" ? user.content : "" },
        description: `The scripted model called ${toolName}.`,
      });
      if (step.kind === "answer") {
        const canSend = request.tools.some(
          (tool) => tool.name === "send_to_user",
        );
        const latest = request.messages.at(-1);
        if (canSend) {
          if (latest?.role !== "tool" || latest.name !== "send_to_user")
            yield {
              type: "tool-call",
              call: {
                id: "probe-send",
                name: "send_to_user",
                input: {
                  disposition: "finish",
                  payload: { type: "text", text: `tool:${step.content}` },
                },
              },
            };
        } else yield { type: "text-delta", text: `tool:${step.content}` };
        yield { type: "finish", reason: "completed" };
        return;
      }
      yield { type: "tool-call", call: step.call };
      yield { type: "finish", reason: "tool-calls" };
    },
  };
  return {
    id: "test-scripted-provider",
    feature: ({ llm }) => llm.register(provider),
  };
}

export class BotIsolateProbe extends DurableObject<BotIsolateProbeEnv> {
  private loaderIds: string[] = [];
  private loadedCode: BotIsolateWorkerCode[] = [];
  private providerRequests: NormalizedModelRequest[] = [];

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
      identityKeys: Object.keys(code.env.IDENTITY).sort(),
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
    hooks: string[] = ["agent/tool-exposure"],
    pair?: { provider?: ArtifactRefV1; consumer: ArtifactRefV1 },
  ): Promise<CompositionGenerationV1> {
    const base = await bootstrapGeneration({ createdAt });
    if (!artifact && !pair) return base;
    const authored = (
      packageId: string,
      descriptor: CompositionMemberV1["descriptor"],
      ref: ArtifactRefV1,
    ): CompositionMemberV1 => ({
      packageId,
      version: "0.0.1",
      descriptor,
      provenance: {
        kind: "bot" as const,
        packageId,
        version: "0.0.1",
        botId: "probe",
        sessionId: "user-1:probe",
        turnId: "turn-1",
        runId: "run-1",
        authoredAt: createdAt,
      },
      artifact: ref,
    });
    const members: CompositionMemberV1[] = [
      ...base.members,
      ...(artifact
        ? [authored(PROBE_PACKAGE_ID, probePackageDescriptor(hooks), artifact)]
        : []),
      // The generation lists members by id, consumer before provider, so the
      // host's ordering — not the listing — is what puts the provider first.
      ...(pair
        ? [
            authored(
              PROBE_CONSUMER_ID,
              PROBE_CONSUMER_DESCRIPTOR,
              pair.consumer,
            ),
            // A pair with no provider artifact is the unmet-need case: the
            // consumer names a service the generation has nobody to meet.
            ...(pair.provider
              ? [
                  authored(
                    PROBE_PROVIDER_ID,
                    PROBE_PROVIDER_DESCRIPTOR,
                    pair.provider,
                  ),
                ]
              : []),
          ]
        : []),
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
    pair?: { provider?: ArtifactRefV1; consumer: ArtifactRefV1 };
    connections?: IsolateConnectionV1[];
    model?: IsolateModelBindingV1;
    memory?: boolean;
    workspace?: boolean;
    /** Varies the generation without varying the artifact. */
    generationCreatedAt?: string;
    deadlineMs?: number;
    /** The hooks the descriptor declares, which must match the source's. */
    hooks?: string[];
  }): Promise<{
    composition: ShellMountedComposition;
    generation: CompositionGenerationV1;
  }> {
    const generation = await this.generation(
      input.artifact,
      input.generationCreatedAt,
      input.hooks,
      input.pair,
    );
    // SAFETY: exported WorkerEntrypoints are materialized on ctx.exports;
    // workers-types cannot infer the generated local RPC stubs.
    const exports = this.ctx.exports as unknown as ProbeExports;
    const composition = await createShellCompositionHost({
      admitEffect: () => Promise.resolve(true),
      botId: input.botId,
      sessionId: `${input.userId}:${input.botId}`,
      sessionEvents: [],
      persistSessionEvents: async (_sessionId, events) => {
        const durable =
          (await this.ctx.storage.get<SessionEvent[]>("session-events")) ?? [];
        await this.ctx.storage.put("session-events", [...durable, ...events]);
      },
      agentPackages: [
        scriptedProviderPackage("reverse_text", this.providerRequests),
      ],
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
        capabilities: exports.BotCapabilities({
          props: {
            userId: input.userId,
            botId: input.botId,
            runId: "run-1",
            sessionId: `${input.userId}:${input.botId}`,
            turnId: "turn-1",
            generationId: generation.generationId,
            packageId: "plugin-worker",
            connections: structuredClone(input.connections ?? []),
            ...(input.model ? { model: structuredClone(input.model) } : {}),
            memory: input.memory ?? false,
            workspace: input.workspace ?? false,
          },
        }),
        bindingDigest: await isolateBindingDigestV1({
          userId: input.userId,
          botId: input.botId,
          connections: input.connections ?? [],
          ...(input.model ? { model: input.model } : {}),
          compositionGenerationId: generation.generationId,
        }),
        compatibilityDate: BOT_ISOLATE_COMPATIBILITY_DATE,
        ...(input.deadlineMs === undefined
          ? {}
          : { deadlineMs: input.deadlineMs }),
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

  /**
   * Mounts the provider and consumer pair as one worker, calls the consumer's
   * tool, and runs one tool-exposure hook through the chain.
   */
  async probePair(input: {
    userId: string;
    botId: string;
    provider: ArtifactRefV1;
    consumer: ArtifactRefV1;
  }): Promise<{
    loaderCalls: number;
    pluginOrder: string[];
    serviceRead: { content: string; isError: boolean };
    exposedTools: string[];
  }> {
    this.loaderIds = [];
    this.loadedCode = [];
    const { composition, generation } = await this.mount({
      userId: input.userId,
      botId: input.botId,
      pair: { provider: input.provider, consumer: input.consumer },
    });
    try {
      await composition.verify(new AbortController().signal);
      const identity = this.loadedCode[0]?.env.IDENTITY;
      const call = dynamicToolCallV1("call-1", {
        namespace: PROBE_CONSUMER_ID,
        toolName: "read_service",
        input: {},
      });
      const context = {
        botId: input.botId,
        agentId: input.botId,
        sessionId: `${input.userId}:${input.botId}`,
        compositionGenerationId: generation.generationId,
        turnType: "chat" as const,
        effectId: "tool:1:1:0",
        signal: new AbortController().signal,
      };
      const preparation = await composition.runtime.services.tools.prepare(
        call,
        { ...context, toolCall: call },
      );
      const serviceRead =
        preparation.kind !== "ready"
          ? preparation.result
          : await composition.runtime.services.tools.executePrepared(
              preparation,
              context,
            );
      const exposed = await composition.runtime.services.hooks.toolExposure(
        composition.runtime.agent.agent as never,
        [],
        1,
        1,
        new AbortController().signal,
        () => Promise.resolve([]),
      );
      return {
        loaderCalls: this.loaderIds.length,
        pluginOrder: identity?.plugins.map((plugin) => plugin.pluginId) ?? [],
        serviceRead,
        exposedTools: exposed.map((tool) => tool.name),
      };
    } finally {
      await composition.dispose();
    }
  }

  /**
   * Mounts a Plugin whose consumed service no sibling provides, alongside one
   * that needs nothing. The unmet Plugin must be excluded and named while the
   * sibling still mounts and still wraps the hook.
   */
  async probeUnmetService(input: {
    userId: string;
    botId: string;
    artifact: ArtifactRefV1;
    consumer: ArtifactRefV1;
  }): Promise<{
    verified: boolean;
    pluginFailures: { pluginId: string; phase: string; message: string }[];
    pluginOrder: string[];
    exposedTools: string[];
  }> {
    this.loaderIds = [];
    this.loadedCode = [];
    const { composition } = await this.mount({
      userId: input.userId,
      botId: input.botId,
      artifact: input.artifact,
      pair: { consumer: input.consumer },
    });
    try {
      let verified = true;
      try {
        await composition.verify(new AbortController().signal);
      } catch {
        verified = false;
      }
      const identity = this.loadedCode[0]?.env.IDENTITY;
      const exposed = await composition.runtime.services.hooks.toolExposure(
        composition.runtime.agent.agent as never,
        [],
        1,
        1,
        new AbortController().signal,
        () => Promise.resolve([]),
      );
      return {
        verified,
        pluginFailures: composition.pluginFailures.map((failure) => ({
          pluginId: failure.pluginId,
          phase: failure.phase,
          message: failure.message,
        })),
        pluginOrder: identity?.plugins.map((plugin) => plugin.pluginId) ?? [],
        exposedTools: exposed.map((tool) => tool.name),
      };
    } finally {
      await composition.dispose();
    }
  }

  /**
   * Mounts three Plugins where one reports health that does not match the
   * descriptor the generation pinned. That Plugin alone must be excluded and
   * named; the other two still mount and still chain their hooks.
   */
  async probeHealthMismatch(input: {
    userId: string;
    botId: string;
    artifact: ArtifactRefV1;
    provider: ArtifactRefV1;
    consumer: ArtifactRefV1;
  }): Promise<{
    verified: boolean;
    pluginFailures: { pluginId: string; phase: string; message: string }[];
    exposedTools: string[];
  }> {
    this.loaderIds = [];
    this.loadedCode = [];
    const { composition } = await this.mount({
      userId: input.userId,
      botId: input.botId,
      artifact: input.artifact,
      // The descriptor claims a hook the module does not export, so the
      // worker's health report cannot match what the generation pinned.
      hooks: ["agent/tool-exposure", "agent/request"],
      pair: { provider: input.provider, consumer: input.consumer },
    });
    try {
      let verified = true;
      try {
        await composition.verify(new AbortController().signal);
      } catch {
        verified = false;
      }
      const exposed = await composition.runtime.services.hooks.toolExposure(
        composition.runtime.agent.agent as never,
        [],
        1,
        1,
        new AbortController().signal,
        () => Promise.resolve([]),
      );
      return {
        verified,
        pluginFailures: composition.pluginFailures.map((failure) => ({
          pluginId: failure.pluginId,
          phase: failure.phase,
          message: failure.message,
        })),
        exposedTools: exposed.map((tool) => tool.name),
      };
    } finally {
      await composition.dispose();
    }
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
    /** Sends the call without the metadata an external namespace demands. */
    omitDescription?: boolean;
  }): Promise<{ content: string; isError: boolean }> {
    const { composition, generation } = await this.mount(input);
    try {
      await composition.verify(new AbortController().signal);
      // A Bot isolate's tools are namespaced by its immutable Package id and
      // the namespace is external, so the only way in is
      // `call_dynamic_tool` carrying that namespace and call metadata. The
      // tests still name the bare tool; the addressing lives here, once.
      const call = dynamicToolCallV1("call-1", {
        namespace: PROBE_PACKAGE_ID,
        toolName: input.tool,
        input: input.toolInput ?? {},
        ...(input.omitDescription
          ? {}
          : { description: `The probe called ${input.tool}.` }),
      });
      const preparation = await composition.runtime.services.tools.prepare(
        call,
        {
          botId: input.botId,
          agentId: input.botId,
          sessionId: `${input.userId}:${input.botId}`,
          compositionGenerationId: generation.generationId,
          turnType: "chat" as const,
          effectId: "tool:1:1:0",
          toolCall: call,
          signal: new AbortController().signal,
        },
      );
      if (preparation.kind !== "ready") return preparation.result;
      return await composition.runtime.services.tools.executePrepared(
        preparation,
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
    deadlineMs?: number;
    hooks?: string[];
  }): Promise<{
    text: string;
    loaderCalls: number;
    providerRequestsJson: string;
    loggedRequestsJson: string;
    firstStepToolNames: string[];
    secondStepToolNames: string[];
    durableHookFailures: Array<{
      type: "package/hook-failed";
      packageId: string;
      event: string;
      generationId: string;
      message: string;
    }>;
  }> {
    this.loaderIds = [];
    this.providerRequests = [];
    await this.ctx.storage.delete("session-events");
    const { composition } = await this.mount(input);
    try {
      await composition.verify(new AbortController().signal);
      composition.runtime.agent.agent.send(input.text);
      await composition.runtime.agent.agent.whenIdle();
      const message = composition.runtime.agent.agent.session
        .deriveMessages()
        .at(-1);
      const loggedRequests = composition.runtime.agent.agent.session.events
        .filter((event) => event.type === "model/request")
        .map((event) => structuredClone(event.request));
      const durableHookFailures = (
        (await this.ctx.storage.get<SessionEvent[]>("session-events")) ?? []
      ).filter(
        (
          event,
        ): event is Extract<SessionEvent, { type: "package/hook-failed" }> =>
          event.type === "package/hook-failed",
      );
      return {
        text: message?.role === "assistant" ? message.content : "",
        loaderCalls: this.loaderIds.length,
        providerRequestsJson: JSON.stringify(this.providerRequests),
        loggedRequestsJson: JSON.stringify(loggedRequests),
        firstStepToolNames:
          this.providerRequests[0]?.tools.map((tool) => tool.name) ?? [],
        secondStepToolNames:
          this.providerRequests[1]?.tools.map((tool) => tool.name) ?? [],
        durableHookFailures: durableHookFailures.map((event) => ({
          type: event.type,
          packageId: event.packageId,
          event: event.event,
          generationId: event.generationId,
          message: event.message,
        })),
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

  /**
   * Delivers app-owned triggers to a Plugin mounted in a real loaded Worker.
   * Nothing in the product produces a trigger yet (step 9 of ADR 0026 owns
   * that), so this stands in for that caller: the host, the generated index
   * and the Plugin's own `triggers` export are all production code, and only
   * the delivery is fixture.
   */
  async probeTriggers(input: {
    userId: string;
    botId: string;
    artifact: ArtifactRefV1;
    deliveries: {
      pluginId?: string;
      trigger: string;
      deadlineMs?: number;
      headers?: Record<string, string>;
      body?: string;
    }[];
    disposeFirst?: boolean;
  }): Promise<{
    mounted: string[];
    failures: { pluginId: string; phase: string; message: string }[];
    results: PluginWorkerTriggerResultV1[];
  }> {
    // An empty generation: the runtime this host registers into, with no
    // Plugin worker of its own.
    const { composition, generation } = await this.mount({
      userId: input.userId,
      botId: input.botId,
    });
    // SAFETY: exported WorkerEntrypoints are materialized on ctx.exports;
    // workers-types cannot infer the generated local RPC stubs.
    const exports = this.ctx.exports as unknown as ProbeExports;
    const member: CompositionMemberV1 = {
      packageId: PROBE_TRIGGER_ID,
      version: "0.0.1",
      descriptor: PROBE_TRIGGER_DESCRIPTOR,
      provenance: {
        kind: "bot" as const,
        packageId: PROBE_TRIGGER_ID,
        version: "0.0.1",
        botId: "probe",
        sessionId: `${input.userId}:probe`,
        turnId: "turn-1",
        runId: "run-1",
        authoredAt: "2026-08-31T00:00:00.000Z",
      },
      artifact: input.artifact,
    };
    const host = new PluginWorkerHost({
      loader: this.countingLoader(),
      artifacts: {
        loadPackageArtifact: async (contentHash) => {
          const object = await this.env.APPLICATION_ARTIFACTS.get(
            `packages/${contentHash}.mjs`,
          );
          if (!object) {
            throw new Error(`package artifact "${contentHash}" is missing`);
          }
          return await object.text();
        },
      },
      tools: composition.runtime.services.tools,
      hooks: composition.runtime.services.hooks,
      userId: input.userId,
      botId: input.botId,
      sessionId: `${input.userId}:${input.botId}`,
      runId: "run-1",
      turnId: "turn-1",
      generationId: generation.generationId,
      turnType: "chat",
      recordHookFailure: () => Promise.resolve(),
      capabilities: exports.BotCapabilities({
        props: {
          userId: input.userId,
          botId: input.botId,
          runId: "run-1",
          sessionId: `${input.userId}:${input.botId}`,
          turnId: "turn-1",
          generationId: generation.generationId,
          packageId: "plugin-worker",
          connections: [],
          memory: false,
          workspace: false,
        },
      }),
      compatibilityDate: BOT_ISOLATE_COMPATIBILITY_DATE,
      bindingDigest: await isolateBindingDigestV1({
        userId: input.userId,
        botId: input.botId,
        connections: [],
        compositionGenerationId: generation.generationId,
      }),
    });
    try {
      const prepared = await host.mount([member]);
      const active = await prepared.commit();
      if (input.disposeFirst) await active.dispose();
      const results: PluginWorkerTriggerResultV1[] = [];
      for (const delivery of input.deliveries) {
        results.push(
          await active.deliverTrigger({
            schemaVersion: 1,
            pluginId: delivery.pluginId ?? PROBE_TRIGGER_ID,
            trigger: delivery.trigger,
            headers: delivery.headers ?? {},
            body: delivery.body ?? "{}",
            botId: input.botId,
            routineId: "routine-1",
            deadlineMs: delivery.deadlineMs ?? 2_000,
          }),
        );
      }
      if (!input.disposeFirst) await active.dispose();
      return {
        mounted: [...prepared.mounted],
        failures: prepared.failures.map((failure) => ({
          pluginId: failure.pluginId,
          phase: failure.phase,
          message: failure.message,
        })),
        results,
      };
    } finally {
      await composition.dispose();
    }
  }

  /** Proves the Durable Object still owns storage the isolate cannot see. */
  async writeStorage(value: string): Promise<void> {
    await this.ctx.storage.put("probe", value);
  }

  async readStorage(): Promise<string | undefined> {
    return await this.ctx.storage.get<string>("probe");
  }
}
