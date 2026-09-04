import {
  BOT_ISOLATE_CONTEXT_KEYS_V1,
  LOOP_EVENTS_V1,
  decodeIsolateCapabilityFailureV1,
  decodeIsolateCapabilityListV1,
  type BotIsolateHookEventNameV1,
} from "@frockbot/kernel-contracts";
import {
  decodeFrockBotManifest,
  isClientIframeContribution,
  type FrockBotManifest,
  type ManifestToolDeclaration,
} from "@frockbot/kernel-composition";
import {
  decodeCompositionGenerationV1,
  type ArtifactRefV1,
  type CompositionGenerationStatusV1,
  type PackageProvenanceV1,
} from "@frockbot/kernel-composition/generation";

type ContextKeyNameV1 = (typeof BOT_ISOLATE_CONTEXT_KEYS_V1)[number];

export interface FrockBotComposeSlotFillV1 {
  slot: string;
  order?: number;
  source:
    | { kind: "first-party-client-module"; entry: string }
    | {
        kind: "sandboxed-iframe-page";
        pageId: string;
        artifactHash: string;
      };
}

export type FrockBotComposeActionV1 =
  | {
      kind: "tool";
      name: string;
      owner: "bot-isolate" | "applet-facet";
      description: string;
      inputSchema: Record<string, unknown>;
    }
  | {
      kind: "loop-hook";
      name: BotIsolateHookEventNameV1;
      owner: "bot-isolate";
      mode: "waterfall";
      payload: string;
      returns: string;
    }
  | {
      kind: "client-entry";
      name: string;
      owner: "hosted-shell";
      slot: "frockbot.sidebar-actions";
      order?: number;
      label: string;
      icon: string;
      opens: { kind: "surface"; page: string };
    };

export interface FrockBotComposeContextKeyV1 {
  name: ContextKeyNameV1;
  readonly: true;
  source: "turn-invocation" | "kernel-capability";
}

export type FrockBotComposeGrantV1 =
  | {
      name: "storage";
      kind: "applet-facet-storage";
      durableOwner: "applet-durable-object";
      scope: "declared-instance";
    }
  | {
      name: "schedule";
      kind: "durable-command";
      durableOwner: "bot-durable-object";
      scope: "turn";
    }
  | {
      name: "tools";
      kind: "tool-registry";
      route: "bot-durable-object";
    }
  | {
      name: "model";
      kind: "model-binding";
      route: "bot-durable-object";
      packageId: string;
      provider: string;
      providerModelId: string;
    }
  | {
      name: "memory" | "workspace";
      kind: "durable-files";
      route: "bot-durable-object";
    }
  | {
      name: "applets";
      kind: "applet-directory";
      route: "bot-durable-object";
    }
  | {
      name: "notifications";
      kind: "notification";
      route: "bot-durable-object";
    }
  | {
      name: `connection:${string}`;
      kind: "opaque-connection-lease";
      route: "bot-durable-object";
      connectionId: string;
      packageId: string;
      connectionTypeId: string;
      generation: string;
    };

export interface FrockBotComposeManifestV1 {
  schemaVersion: 1;
  packageId: string;
  packageVersion: string;
  slots: {
    declares: string[];
    fills: FrockBotComposeSlotFillV1[];
  };
  actions: FrockBotComposeActionV1[];
  keys: FrockBotComposeContextKeyV1[];
  grants: Array<
    Extract<FrockBotComposeGrantV1, { name: "storage" | "schedule" }>
  >;
  requirements: {
    permissions: string[];
    capabilities: Array<{
      id: string;
      kind: "tool" | "model" | "memory" | "notification" | "computer";
      connectionTypes: string[];
      admission?: { turnTypes: string[]; subagentRoles?: string[] };
    }>;
    connectionTypes: Array<{
      id: string;
      authorization: "none" | "api-key" | "ambient-native" | "grant";
      capabilities: string[];
    }>;
  };
  execution: {
    compile: "outside-durable-objects";
    activate: "next-admitted-turn";
    runtime:
      "none" | "first-party-backend-runtime" | "cloudflare-dynamic-worker";
    instance: "none" | "cloudflare-applet-facet";
    ambientState: false;
    ambientTimers: false;
  };
}

export type FrockBotComposeAuthorityV1 =
  | { schemaVersion: 1; status: "unavailable"; reason: string; grants: [] }
  | {
      schemaVersion: 1;
      status: "available";
      grants: Array<Exclude<FrockBotComposeGrantV1, { name: "storage" }>>;
    };

export interface FrockBotComposeGenerationV1 {
  schemaVersion: 1;
  generationId: string;
  artifactSetHash: string;
  status: CompositionGenerationStatusV1;
  packages: Array<{
    packageId: string;
    version: string;
    provenance: PackageProvenanceV1["kind"];
    host: "first-party-runtime" | "cloudflare-dynamic-worker";
    artifact?: ArtifactRefV1;
  }>;
  applets: Array<{
    appletId: string;
    generationId: string;
    host: "cloudflare-applet-facet";
    storage: "applet-durable-object";
  }>;
  lifecycle: {
    compile: "outside-durable-objects";
    activate: "next-admitted-turn";
    immutableArtifacts: true;
    revertCreatesGeneration: true;
  };
  revertsTo?: string;
}

const CAPABILITY_CONTEXT_KEYS_V1 = new Set<ContextKeyNameV1>([
  "capabilities",
  "model",
  "tools",
  "memory",
  "workspace",
  "applets",
  "connection",
  "notify",
  "schedule",
]);

function contextKeysV1(): FrockBotComposeContextKeyV1[] {
  return BOT_ISOLATE_CONTEXT_KEYS_V1.map((name) => ({
    name,
    readonly: true,
    source: CAPABILITY_CONTEXT_KEYS_V1.has(name)
      ? "kernel-capability"
      : "turn-invocation",
  }));
}

function toolActionsV1(
  tools: readonly ManifestToolDeclaration[] | undefined,
  owner: "bot-isolate" | "applet-facet",
): FrockBotComposeActionV1[] {
  return (tools ?? []).map((tool) => ({
    kind: "tool",
    name: tool.name,
    owner,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

function hookActionV1(
  name: BotIsolateHookEventNameV1,
): FrockBotComposeActionV1 {
  const event = LOOP_EVENTS_V1[name];
  return {
    kind: "loop-hook",
    name,
    owner: "bot-isolate",
    mode: "waterfall",
    payload: event.payload,
    returns: event.returns,
  };
}

function manifestSlotsV1(manifest: FrockBotManifest): {
  declares: string[];
  fills: FrockBotComposeSlotFillV1[];
} {
  const client = manifest.contributions.client;
  if (!client) return { declares: [], fills: [] };
  if (!isClientIframeContribution(client)) {
    return {
      declares: [...client.outlets],
      fills: client.mounts.map((mount) => ({
        slot: mount.slot,
        ...(mount.order === undefined ? {} : { order: mount.order }),
        source: { kind: "first-party-client-module", entry: client.entry },
      })),
    };
  }
  return {
    declares: [],
    fills: client.pages.flatMap((page) =>
      page.mounts.map((mount) => ({
        slot: mount.slot,
        ...(mount.order === undefined ? {} : { order: mount.order }),
        source: {
          kind: "sandboxed-iframe-page",
          pageId: page.id,
          artifactHash: page.artifact.contentHash,
        },
      })),
    ),
  };
}

function clientActionsV1(
  manifest: FrockBotManifest,
): FrockBotComposeActionV1[] {
  const client = manifest.contributions.client;
  if (!client || !isClientIframeContribution(client)) return [];
  return (client.entries ?? []).map((entry) => ({
    kind: "client-entry",
    name: entry.id,
    owner: "hosted-shell",
    slot: entry.slot,
    ...(entry.order === undefined ? {} : { order: entry.order }),
    label: entry.label,
    icon: entry.icon,
    opens: entry.opens,
  }));
}

/**
 * Decode an untrusted Package manifest, then project only its named extension
 * surface. The projection describes authority; it never grants or activates it.
 */
export function adaptFrockBotManifestV1(
  input: unknown,
): FrockBotComposeManifestV1 {
  const manifest = decodeFrockBotManifest(input);
  const runtime = manifest.contributions.runtime;
  const instance = manifest.contributions.instance;
  const configuration = manifest.configuration;
  const grants: FrockBotComposeManifestV1["grants"] = [];
  if (instance) {
    grants.push({
      name: "storage",
      kind: "applet-facet-storage",
      durableOwner: "applet-durable-object",
      scope: "declared-instance",
    });
  }
  if (runtime?.host === "bot-isolate") {
    grants.push({
      name: "schedule",
      kind: "durable-command",
      durableOwner: "bot-durable-object",
      scope: "turn",
    });
  }

  return {
    schemaVersion: 1,
    packageId: manifest.id,
    packageVersion: manifest.version,
    slots: manifestSlotsV1(manifest),
    actions: [
      ...toolActionsV1(manifest.tools, "bot-isolate"),
      ...toolActionsV1(instance?.tools, "applet-facet"),
      ...(manifest.hooks ?? []).map(hookActionV1),
      ...clientActionsV1(manifest),
    ],
    keys: runtime?.host === "bot-isolate" ? contextKeysV1() : [],
    grants,
    requirements: {
      permissions: [...manifest.permissions],
      capabilities: (configuration?.capabilities ?? []).map((capability) => ({
        id: capability.id,
        kind: capability.kind,
        connectionTypes: [...capability.connectionTypes],
        ...(capability.admission === undefined
          ? {}
          : {
              admission: {
                turnTypes: [...capability.admission.turnTypes],
                ...(capability.admission.subagentRoles === undefined
                  ? {}
                  : {
                      subagentRoles: [...capability.admission.subagentRoles],
                    }),
              },
            }),
      })),
      connectionTypes: (configuration?.connectionTypes ?? []).map(
        (connectionType) => ({
          id: connectionType.id,
          authorization: connectionType.authorization.kind,
          capabilities: [...connectionType.capabilities],
        }),
      ),
    },
    execution: {
      compile: "outside-durable-objects",
      activate: "next-admitted-turn",
      runtime:
        runtime === undefined
          ? "none"
          : runtime.host === "bot-isolate"
            ? "cloudflare-dynamic-worker"
            : "first-party-backend-runtime",
      instance: instance ? "cloudflare-applet-facet" : "none",
      ambientState: false,
      ambientTimers: false,
    },
  };
}

function isUnavailableV1(input: unknown): boolean {
  return (
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    Reflect.get(input, "status") === "unavailable"
  );
}

/** Project the exact per-Turn capability list into named, credential-free grants. */
export function adaptFrockBotAuthorityV1(
  input: unknown,
): FrockBotComposeAuthorityV1 {
  if (isUnavailableV1(input)) {
    const failure = decodeIsolateCapabilityFailureV1(input);
    return {
      schemaVersion: 1,
      status: "unavailable",
      reason: failure.reason,
      grants: [],
    };
  }

  const capabilities = decodeIsolateCapabilityListV1(input);
  const grants: Array<Exclude<FrockBotComposeGrantV1, { name: "storage" }>> = [
    { name: "tools", kind: "tool-registry", route: "bot-durable-object" },
    {
      name: "applets",
      kind: "applet-directory",
      route: "bot-durable-object",
    },
    {
      name: "notifications",
      kind: "notification",
      route: "bot-durable-object",
    },
    {
      name: "schedule",
      kind: "durable-command",
      durableOwner: "bot-durable-object",
      scope: "turn",
    },
  ];
  if (capabilities.model) {
    grants.push({
      name: "model",
      kind: "model-binding",
      route: "bot-durable-object",
      packageId: capabilities.model.packageId,
      provider: capabilities.model.provider,
      providerModelId: capabilities.model.providerModelId,
    });
  }
  if (capabilities.memory) {
    grants.push({
      name: "memory",
      kind: "durable-files",
      route: "bot-durable-object",
    });
  }
  if (capabilities.workspace) {
    grants.push({
      name: "workspace",
      kind: "durable-files",
      route: "bot-durable-object",
    });
  }
  for (const connection of capabilities.connections) {
    grants.push({
      name: `connection:${connection.connectionId}`,
      kind: "opaque-connection-lease",
      route: "bot-durable-object",
      connectionId: connection.connectionId,
      packageId: connection.packageId,
      connectionTypeId: connection.connectionTypeId,
      generation: connection.generation,
    });
  }
  return { schemaVersion: 1, status: "available", grants };
}

/**
 * Project a decoded Composition generation without mounting it. Non-first-party
 * code without a content-addressed artifact fails closed at this adapter seam.
 */
export function adaptFrockBotGenerationV1(
  input: unknown,
): FrockBotComposeGenerationV1 {
  const generation = decodeCompositionGenerationV1(input);
  const packages = generation.members.map((member) => {
    if (member.provenance.kind !== "first-party" && !member.artifact) {
      throw new Error(
        `composition member "${member.packageId}" has non-first-party provenance without an immutable artifact`,
      );
    }
    return {
      packageId: member.packageId,
      version: member.version,
      provenance: member.provenance.kind,
      host: member.artifact
        ? ("cloudflare-dynamic-worker" as const)
        : ("first-party-runtime" as const),
      ...(member.artifact === undefined ? {} : { artifact: member.artifact }),
    };
  });
  return {
    schemaVersion: 1,
    generationId: generation.generationId,
    artifactSetHash: generation.artifactSetHash,
    status: generation.status,
    packages,
    applets: (generation.applets ?? []).map((applet) => ({
      appletId: applet.appletId,
      generationId: applet.generationId,
      host: "cloudflare-applet-facet",
      storage: "applet-durable-object",
    })),
    lifecycle: {
      compile: "outside-durable-objects",
      activate: "next-admitted-turn",
      immutableArtifacts: true,
      revertCreatesGeneration: true,
    },
    ...(generation.origin.kind === "revert"
      ? { revertsTo: generation.origin.revertsTo }
      : {}),
  };
}
