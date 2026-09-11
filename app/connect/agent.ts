// What a connected app is to a Bot: one Tool Namespace named for the app,
// carrying the app's important tools, mounted for each ready Connection the
// User holds. Nothing is in the prompt for an app nobody connected.
//
// AUTHORITY. A namespace exists only through an enabled `connect-<app>-tools`
// Capability bound to a `ready` Connection, which the runtime host has already
// authorized before this factory is asked. The account id comes off that
// Connection's safe metadata; the provider key is the deployment's.
//
// SCHEMAS. The app's tool list is read once per Turn and pinned by the Turn,
// so a Turn keeps the exact schemas it was admitted under across eviction. A
// provider that cannot be reached leaves the namespace registered in `error`
// with no tools: the model is told the app is unusable rather than shown a
// catalog that is not there.
//
// EFFECTS. A tool call here is an external effect the provider offers no
// idempotency key for. It is dispatched once per occurrence; a transport
// failure after dispatch answers that the outcome is unknown and tells the
// model not to repeat it.
import type {
  AgentRuntimeV1,
  RuntimeFeatureV1,
  ToolExecutionResult,
} from "@frockbot/core/contracts";
import type { ConnectionView } from "@frockbot/core/configuration";
import {
  ComposioClient,
  ComposioRequestError,
  type ComposioFetch,
  type ConnectToolV1,
} from "./composio.js";
import { CONNECT_PACKAGE_ID } from "./catalog.js";
import { connectSafeMetadataV1 } from "./user.js";

/** Longest tool answer handed back to the model. */
const MAX_RESULT_BYTES = 128_000;
/** Longest argument bag sent to the provider. */
const MAX_ARGUMENT_BYTES = 64_000;

export interface ConnectRuntimeConfig {
  userId: string;
  connection: ConnectionView;
  apiKey: string;
  apiBaseUrl?: string;
  fetch?: ComposioFetch;
  client?: ComposioClient;
  pinToolCatalog?(
    connectionId: string,
    read: () => Promise<unknown>,
  ): Promise<unknown>;
}

/** The pinned catalog, as a later mount of the same Turn reads it back. */
export interface ConnectToolCatalogV1 {
  schemaVersion: 1;
  toolkitSlug: string;
  tools: ConnectToolV1[];
}

export function decodeConnectToolCatalogV1(
  value: unknown,
): ConnectToolCatalogV1 {
  if (
    !value ||
    typeof value !== "object" ||
    (value as ConnectToolCatalogV1).schemaVersion !== 1 ||
    typeof (value as ConnectToolCatalogV1).toolkitSlug !== "string" ||
    !Array.isArray((value as ConnectToolCatalogV1).tools)
  ) {
    throw new Error("Pinned tool catalog is invalid");
  }
  const catalog = value as ConnectToolCatalogV1;
  for (const tool of catalog.tools) {
    if (
      !tool ||
      typeof tool.slug !== "string" ||
      typeof tool.name !== "string" ||
      typeof tool.description !== "string" ||
      typeof tool.version !== "string" ||
      !tool.inputSchema ||
      typeof tool.inputSchema !== "object"
    ) {
      throw new Error("Pinned tool catalog is invalid");
    }
  }
  return catalog;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** Mount one connected app's namespace for one Turn. */
export function createConnectFeature(
  config: ConnectRuntimeConfig,
): RuntimeFeatureV1<AgentRuntimeV1> {
  return async (runtime) => {
    const metadata = connectSafeMetadataV1(config.connection);
    if (!metadata) {
      throw new Error("Connected app Connection is missing its account");
    }
    const client =
      config.client ??
      new ComposioClient({
        apiKey: config.apiKey,
        ...(config.apiBaseUrl ? { baseUrl: config.apiBaseUrl } : {}),
        ...(config.fetch ? { fetch: config.fetch } : {}),
      });
    const read = async (): Promise<ConnectToolCatalogV1> => ({
      schemaVersion: 1,
      toolkitSlug: metadata.toolkitSlug,
      tools: await client.listImportantTools(metadata.toolkitSlug),
    });
    let catalog: ConnectToolCatalogV1 | undefined;
    try {
      catalog = decodeConnectToolCatalogV1(
        config.pinToolCatalog
          ? await config.pinToolCatalog(config.connection.connectionId, read)
          : await read(),
      );
    } catch {
      catalog = undefined;
    }
    const label =
      config.connection.displayName === metadata.toolkitName
        ? metadata.toolkitName
        : `${metadata.toolkitName} (${config.connection.displayName})`;
    const cleanups = [
      runtime.tools.registerNamespace({
        name: metadata.namespace,
        description: catalog
          ? `${label}: the User's connected account.`
          : `${label}: the User's connected account. Its tools could not be loaded for this Turn.`,
        status: catalog ? "ready" : "error",
        useInstructions: `Tools for the User's ${label} account. Read a tool's schema with get_dynamic_tools before calling it. Each call acts on the real account, so confirm anything that sends, posts or deletes.`,
      }),
    ];
    for (const tool of catalog?.tools ?? []) {
      cleanups.push(
        runtime.tools.register(
          {
            namespace: metadata.namespace,
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            idempotent: false,
            execute: (input) =>
              executeConnectTool(client, {
                userId: config.userId,
                connectedAccountId: metadata.connectedAccountId,
                tool,
                input,
              }),
          },
          {
            admissionCeiling: ["chat", "automation", "subagent"],
            subagentRoleCeiling: ["executor"],
          },
        ),
      );
    }
    return cleanups;
  };
}

export async function executeConnectTool(
  client: Pick<ComposioClient, "executeTool">,
  call: {
    userId: string;
    connectedAccountId: string;
    tool: ConnectToolV1;
    input: unknown;
  },
): Promise<ToolExecutionResult> {
  const args =
    call.input && typeof call.input === "object" && !Array.isArray(call.input)
      ? (call.input as Record<string, unknown>)
      : {};
  if (byteLength(JSON.stringify(args)) > MAX_ARGUMENT_BYTES) {
    return {
      content: "The arguments are too large for this tool.",
      isError: true,
    };
  }
  try {
    const result = await client.executeTool({
      toolSlug: call.tool.slug,
      userId: call.userId,
      connectedAccountId: call.connectedAccountId,
      arguments: args,
      version: call.tool.version,
    });
    if (!result.successful) {
      return {
        content: `The app refused this action${result.error ? `: ${result.error}` : "."} Check the inputs before retrying.`,
        isError: true,
      };
    }
    const content = JSON.stringify(result.data);
    if (byteLength(content) > MAX_RESULT_BYTES) {
      return {
        content:
          "The app's answer is too large to show. Ask for less at a time.",
        isError: true,
      };
    }
    return { content, isError: false };
  } catch (error) {
    // A refusal the provider gave before doing anything is safe to retry
    // after fixing the call; anything else may have gone through.
    const refused =
      error instanceof ComposioRequestError &&
      [400, 401, 403, 404, 422].includes(error.status);
    if (error instanceof ComposioRequestError && error.status === 401) {
      return {
        content: "The account needs reconnecting before this app can be used.",
        isError: true,
      };
    }
    return {
      content: refused
        ? "The action was not started. Check its inputs and the account's connection status."
        : "The action's outcome could not be confirmed. Do not repeat it; check the account for its result.",
      isError: true,
    };
  }
}

/**
 * The enablement fence: a namespace exists for a Bot only through an enabled
 * `connect-<app>-tools` Capability bound to a ready Connection of this
 * Package. Anything else mounts nothing.
 */
export function createConfiguredConnectRuntimeContribution(config: {
  capability: {
    packageId: string;
    capabilityId: string;
    connectionId?: string;
  };
  userId: string;
  connection?: ConnectionView;
  apiKey?: string;
  apiBaseUrl?: string;
  fetch?: ComposioFetch;
  pinToolCatalog?: ConnectRuntimeConfig["pinToolCatalog"];
}): RuntimeFeatureV1<AgentRuntimeV1> | undefined {
  if (
    config.capability.packageId !== CONNECT_PACKAGE_ID ||
    !config.capability.connectionId ||
    !config.connection ||
    config.connection.connectionId !== config.capability.connectionId ||
    config.connection.state !== "ready" ||
    !config.apiKey?.trim()
  ) {
    return undefined;
  }
  return createConnectFeature({
    userId: config.userId,
    connection: config.connection,
    apiKey: config.apiKey,
    ...(config.apiBaseUrl ? { apiBaseUrl: config.apiBaseUrl } : {}),
    ...(config.fetch ? { fetch: config.fetch } : {}),
    ...(config.pinToolCatalog ? { pinToolCatalog: config.pinToolCatalog } : {}),
  });
}
