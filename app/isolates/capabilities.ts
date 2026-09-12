// The Bot Durable Object half of the isolate capability boundary.
//
// Every Package mounted for one Bot receives the same authority projection:
// the User's ready Connections, the Bot's configured model, and the shared
// tool, Memory, Workspace, and notification surfaces. Package identity remains
// in props only for attribution; it never narrows the authority list.
import type {
  IsolateCapabilityListV1,
  IsolateConnectionLeaseV1,
  IsolateConnectionOutcomeV1,
  IsolateConnectionV1,
  IsolateModelBindingV1,
  IsolateModelInvocationV1,
  LlmStreamEvent,
  NormalizedModelRequest,
} from "@frockbot/core/contracts";
import {
  encodeIsolateModelEventLineV1,
  pluginNetworkAdmitsHostV1,
} from "@frockbot/core/contracts";
import type { BotIsolateArtifactStore } from "@frockbot/frock-compose";

export type { IsolateModelBindingV1 } from "@frockbot/core/contracts";

export const BOT_ISOLATE_COMPATIBILITY_DATE = "2026-08-27";

/**
 * What the loopback stub is minted with: the User, and nothing else. Which
 * Turn, Bot and Plugin a call is for arrives on the call itself, and the Bot
 * Durable Object resolves the authority for that Turn when it is called, so
 * the stub never holds a snapshot that can go stale in a cached worker.
 */
export interface BotCapabilitiesPropsV1 {
  userId: string;
}

/**
 * What the egress loopback is minted with. Every Plugin in the worker shares
 * a realm, so the policy is the union of what the enabled Plugins declared
 * and is described to the User that way.
 */
export interface PluginEgressPropsV1 {
  userId: string;
  hosts: string[];
  open: boolean;
}

export const ISOLATE_MODEL_REQUEST_PREFIX = "isolate:model-request:";

export interface IsolateModelRequestRecordV1 {
  schemaVersion: 1;
  recordId: string;
  requestId: string;
  botId: string;
  packageId: string;
  generationId: string;
  request: NormalizedModelRequest;
  recordedAt: string;
}

export interface IsolateCapabilityStore {
  put(key: string, value: unknown): Promise<void>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
}

export const MAX_ISOLATE_REQUEST_ID = 256;

export interface IsolateModelPath {
  stream(
    request: NormalizedModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<LlmStreamEvent>;
}

export interface IsolateCapabilityHostOptions {
  storage: IsolateCapabilityStore;
  botId: string;
  packageId: string;
  generationId: string;
  connections: readonly IsolateConnectionV1[];
  modelBinding?: IsolateModelBindingV1;
  modelPath?: IsolateModelPath;
  memory: boolean;
  workspace: boolean;
  now?(): Date;
  newId?(): string;
}

export interface IsolateCapabilityHost {
  list(): Promise<IsolateCapabilityListV1>;
  invokeModel(
    request: NormalizedModelRequest,
  ): Promise<IsolateModelInvocationV1>;
  recordedModelRequests(): Promise<IsolateModelRequestRecordV1[]>;
}

export function matchingModelBindingV1(
  binding: IsolateModelBindingV1 | undefined,
  request: NormalizedModelRequest,
): IsolateModelBindingV1 | undefined {
  const admitted = request.modelBinding;
  if (
    !binding ||
    !admitted ||
    request.provider !== binding.provider ||
    request.model !== binding.providerModelId ||
    admitted.connectionId !== binding.connectionId ||
    admitted.connectionGeneration !== binding.connectionGeneration ||
    admitted.catalogGeneration !== binding.catalogGeneration
  ) {
    return undefined;
  }
  return binding;
}

export function createIsolateCapabilityHost(
  options: IsolateCapabilityHostOptions,
): IsolateCapabilityHost {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => crypto.randomUUID());

  return {
    list(): Promise<IsolateCapabilityListV1> {
      return Promise.resolve({
        status: "available",
        connections: structuredClone([...options.connections]),
        ...(options.modelBinding
          ? { model: structuredClone(options.modelBinding) }
          : {}),
        tools: true,
        memory: options.memory,
        workspace: options.workspace,
        schedule: true,
      });
    },

    async invokeModel(
      request: NormalizedModelRequest,
    ): Promise<IsolateModelInvocationV1> {
      if (request.requestId.length > MAX_ISOLATE_REQUEST_ID) {
        throw new Error("isolate model request requestId is not bounded");
      }
      const binding = matchingModelBindingV1(options.modelBinding, request);
      if (!binding || !options.modelPath) {
        return {
          status: "unavailable",
          reason: options.modelBinding
            ? "the request does not match this Bot's configured model"
            : "this Bot has no configured model",
        };
      }
      const forwarded: NormalizedModelRequest = {
        ...structuredClone(request),
        modelBinding: {
          connectionId: binding.connectionId,
          connectionGeneration: binding.connectionGeneration,
          ...(binding.catalogGeneration
            ? { catalogGeneration: binding.catalogGeneration }
            : {}),
        },
      };
      const recordId = `model-request-${newId()}`;
      const record: IsolateModelRequestRecordV1 = {
        schemaVersion: 1,
        recordId,
        requestId: request.requestId,
        botId: options.botId,
        packageId: options.packageId,
        generationId: options.generationId,
        request: forwarded,
        recordedAt: now().toISOString(),
      };
      await options.storage.put(
        `${ISOLATE_MODEL_REQUEST_PREFIX}${recordId}`,
        record,
      );
      const controller = new AbortController();
      return {
        status: "streaming",
        requestId: request.requestId,
        events: isolateModelEventStreamV1(
          options.modelPath.stream(forwarded, controller.signal),
          controller,
        ),
      };
    },

    async recordedModelRequests(): Promise<IsolateModelRequestRecordV1[]> {
      const stored = await options.storage.list<IsolateModelRequestRecordV1>({
        prefix: ISOLATE_MODEL_REQUEST_PREFIX,
      });
      return [...stored.values()];
    },
  };
}

/**
 * Model events cross the isolate boundary as an NDJSON byte stream. A
 * `ReadableStream` of JavaScript objects is not transferable over workerd RPC;
 * a byte stream is, so the kernel encodes here and the generated wrapper
 * decodes on the far side.
 */
export const ISOLATE_MODEL_FAILURE_MESSAGE =
  "the model provider did not complete this request";

export function isolateModelEventStreamV1(
  events: AsyncIterable<LlmStreamEvent>,
  controller?: AbortController,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const iterator = events[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(stream) {
      try {
        const next = await iterator.next();
        if (next.done) {
          stream.close();
          return;
        }
        stream.enqueue(
          encoder.encode(encodeIsolateModelEventLineV1(next.value)),
        );
      } catch {
        // Provider errors are normalized before they cross into Bot code: a
        // raw provider message can name endpoints, account state, or the
        // credential that failed. The Bot learns that the request did not
        // complete and nothing else; the durable record and the provider
        // Plugin keep the detail.
        stream.error(new Error(ISOLATE_MODEL_FAILURE_MESSAGE));
      }
    },
    cancel(reason) {
      controller?.abort(reason);
      return iterator.return?.(undefined).then(() => undefined);
    },
  });
}

/**
 * The content address of what is baked into a Plugin worker's `env`: the
 * User the `CAPABILITIES` stub is minted for, and the egress policy the
 * `globalOutbound` stub enforces. Nothing per Turn or per Bot belongs here:
 * every capability call names its scope, and the Bot Durable Object resolves
 * that Turn's authority when it is called, so a cached worker never answers
 * under a stale snapshot. A changed policy — a Plugin declaring a new host
 * enabled or disabled — is a new worker.
 */
export async function pluginWorkerBindingDigestV1(input: {
  userId: string;
  egress: Pick<PluginEgressPropsV1, "hosts" | "open"> | undefined;
}): Promise<string> {
  return await sha256Hex(
    JSON.stringify({
      version: 2,
      userId: input.userId,
      egress: input.egress
        ? { hosts: [...input.egress.hosts].sort(), open: input.egress.open }
        : null,
    }),
  );
}

/** Whether one request's URL is inside the policy a worker's egress was minted with. */
export function pluginEgressAdmitsV1(
  policy: Pick<PluginEgressPropsV1, "hosts" | "open">,
  url: string,
): { admitted: true; host: string } | { admitted: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { admitted: false, reason: "the request URL is invalid" };
  }
  if (parsed.protocol !== "https:") {
    return {
      admitted: false,
      reason: `plugin egress is https only; "${parsed.protocol}" is refused`,
    };
  }
  const host = parsed.hostname.toLowerCase();
  const network = policy.open
    ? { open: true as const }
    : { hosts: policy.hosts };
  if (!pluginNetworkAdmitsHostV1(network, host)) {
    return {
      admitted: false,
      reason: `plugin egress to "${host}" is not declared by any enabled plugin on this account`,
    };
  }
  return { admitted: true, host };
}

/**
 * The egress policy for one Bot's Turn: the union of the declared hosts of
 * the enabled Plugins, or open access if any of them asked for it, or nothing
 * when none holds the http grant. `undefined` leaves `globalOutbound` null.
 */
export function pluginEgressPolicyV1(
  plugins: readonly { network?: { hosts: string[] } | { open: true } }[],
): Pick<PluginEgressPropsV1, "hosts" | "open"> | undefined {
  const hosts = new Set<string>();
  let open = false;
  let any = false;
  for (const plugin of plugins) {
    if (!plugin.network) continue;
    any = true;
    if ("open" in plugin.network) open = true;
    else for (const host of plugin.network.hosts) hosts.add(host);
  }
  if (!any) return undefined;
  return open ? { hosts: [], open: true } : { hosts: [...hosts].sort(), open };
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

/**
 * Reads a Bot Package artifact from object storage and verifies its content
 * address before a byte of it becomes code. Artifacts are immutable content,
 * not state; the hash is the only thing that makes them safe to mount.
 *
 * Nothing is ever *built* here, which is what "Composition consumes immutable
 * content-addressed artifacts and never builds them" asks of this seam.
 */
export function createR2PackageArtifactStore(
  bucket: R2Bucket,
): BotIsolateArtifactStore {
  return {
    async loadPackageArtifact(contentHash: string): Promise<string> {
      const key = `packages/${contentHash}.mjs`;
      const object = await bucket.get(key);
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
  };
}
