// The Bot Durable Object half of the isolate capability boundary.
//
// A loaded Bot Package sees exactly two bindings: `IDENTITY` (a plain object)
// and `CAPABILITIES` (a loopback service binding). Every method behind
// `CAPABILITIES` ends up here, in the authority that owns the Bot's durable
// state. Missing authority is a declared unavailable outcome, and a model call records its normalized request and
// acquires its credential lease through the existing provider path before a
// single byte leaves the account.
import type {
  IsolateCapabilityFailureV1,
  IsolateCapabilityDescriptorV1,
  IsolateModelOutcomeV1,
  LlmStreamEvent,
  NormalizedModelRequest,
} from "@frockbot/kernel-contracts";
import { encodeIsolateModelEventLineV1 } from "@frockbot/kernel-contracts";
import type { BotIsolateArtifactStore } from "@frockbot/kernel-composition/isolate";
import type { EnabledCapabilityV1 } from "@frockbot/configuration-core";

/**
 * The compatibility date every Bot isolate is loaded with. Pinned beside the
 * gateway Worker's own so Bot-authored code cannot outrun the kernel wrapper.
 */
export const BOT_ISOLATE_COMPATIBILITY_DATE = "2026-08-27";

/**
 * What travels in `ctx.exports.BotCapabilities({ props })`. Structured-clonable
 * by necessity: props cross into a loopback service binding.
 */
export interface BotCapabilitiesPropsV1 {
  userId: string;
  botId: string;
  generationId: string;
  packageId: string;
  /** The User's enabled set, already resolved by the authority. */
  capabilities: IsolateCapabilityV1[];
}

export const ISOLATE_MODEL_REQUEST_PREFIX = "isolate:model-request:";

/** The intent recorded before a Bot-authored adapter's model call is forwarded. */
export interface IsolateModelRequestRecordV1 {
  schemaVersion: 1;
  /** Minted by this Durable Object; the record is keyed by it. */
  recordId: string;
  /** The Bot's own correlation id. Bounded, and never a storage key. */
  requestId: string;
  botId: string;
  packageId: string;
  generationId: string;
  capabilityId: string;
  request: NormalizedModelRequest;
  recordedAt: string;
}

/** The narrow storage surface this module needs from the Durable Object. */
export interface IsolateCapabilityStore {
  put(key: string, value: unknown): Promise<void>;
  get<T>(key: string): Promise<T | undefined>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
}

/** One account-wide Capability, already resolved from User enablement. */
export type IsolateCapabilityV1 = EnabledCapabilityV1;

/**
 * The Bot's effective model binding, resolved by the authority from generic
 * Package settings and the User's Connection — never from anything the Bot
 * supplied. An `invokeModel` request is authorized only when it names exactly
 * this provider and this model, and it is forwarded carrying exactly this
 * binding.
 */
export interface IsolateModelBindingV1 {
  packageId: string;
  capabilityId: string;
  connectionId: string;
  provider: string;
  providerModelId: string;
  connectionGeneration?: string;
  catalogGeneration?: string;
}

/** A configured model binding whose Connection cannot currently be used. */
export interface IsolateUnavailableModelBindingV1 {
  provider?: string;
  providerModelId: string;
}

export const ISOLATE_MODEL_UNAVAILABLE_MESSAGE =
  "the enabled model binding is unavailable";

/** The bound Bot-supplied correlation id: a field, never a key, and never unbounded. */
export const MAX_ISOLATE_REQUEST_ID = 256;

export interface IsolateModelPath {
  /** Streams through the mounted provider Plugin; the lease is taken inside it. */
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
  /** User-enabled and nothing else. */
  capabilities: readonly IsolateCapabilityV1[];
  /**
   * The one ready model binding resolved for this Bot. Absent means model
   * invocation is unavailable; there is no authority-request path.
   */
  modelBinding?: IsolateModelBindingV1;
  /** Present when the configured binding is held but its Connection is unavailable. */
  unavailableModelBinding?: IsolateUnavailableModelBindingV1;
  /** Present only while the ready binding can reach its provider path. */
  modelPath?: IsolateModelPath;
  now?(): Date;
  newId?(): string;
}

export interface IsolateCapabilityHost {
  list(): Promise<IsolateCapabilityDescriptorV1[]>;
  invokeModel(request: NormalizedModelRequest): Promise<IsolateModelOutcomeV1>;
  recordedModelRequests(): Promise<IsolateModelRequestRecordV1[]>;
}

/**
 * The enabled model Capability that can serve this request, if any.
 *
 * The authority resolves the effective model against one User-enabled
 * Package, Connection, and Capability. A request naming any other provider or
 * model resolves to nothing, whatever the Bot claims about it — the
 * Bot-supplied `modelBinding` is never read here or anywhere downstream.
 */
export function matchingModelCapabilityV1(
  capabilities: readonly IsolateCapabilityV1[],
  binding: IsolateModelBindingV1 | undefined,
  request: NormalizedModelRequest,
): IsolateCapabilityV1 | undefined {
  if (!binding) return undefined;
  if (
    request.provider !== binding.provider ||
    request.model !== binding.providerModelId
  ) {
    return undefined;
  }
  return capabilities.find(
    (capability) =>
      capability.kind === "model" &&
      capability.packageId === binding.packageId &&
      capability.capabilityId === binding.capabilityId &&
      capability.connectionId === binding.connectionId,
  );
}

export function createIsolateCapabilityHost(
  options: IsolateCapabilityHostOptions,
): IsolateCapabilityHost {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => crypto.randomUUID());

  return {
    list(): Promise<IsolateCapabilityDescriptorV1[]> {
      return Promise.resolve(
        options.capabilities.map((capability) => ({
          capabilityId: capability.capabilityId,
          kind: capability.kind,
        })),
      );
    },

    async invokeModel(
      request: NormalizedModelRequest,
    ): Promise<IsolateModelOutcomeV1> {
      if (request.requestId.length > MAX_ISOLATE_REQUEST_ID) {
        throw new Error("isolate model request requestId is not bounded");
      }
      const binding = options.modelBinding;
      const capability = matchingModelCapabilityV1(
        options.capabilities,
        binding,
        request,
      );
      const unavailableBinding = options.unavailableModelBinding;
      if (
        unavailableBinding &&
        request.model === unavailableBinding.providerModelId &&
        (unavailableBinding.provider === undefined ||
          request.provider === unavailableBinding.provider)
      ) {
        return {
          status: "unavailable",
          reason: ISOLATE_MODEL_UNAVAILABLE_MESSAGE,
        } satisfies IsolateCapabilityFailureV1;
      }
      if (capability && binding && !options.modelPath) {
        return {
          status: "unavailable",
          reason: ISOLATE_MODEL_UNAVAILABLE_MESSAGE,
        } satisfies IsolateCapabilityFailureV1;
      }
      if (!capability || !binding || !options.modelPath) {
        return {
          status: "unavailable",
          reason: "the model is unavailable",
        } satisfies IsolateCapabilityFailureV1;
      }
      // The binding the provider path receives is the authority's, never the
      // Bot's: a Bot-composed request carries no Connection authority.
      const forwarded: NormalizedModelRequest = {
        ...structuredClone(request),
        modelBinding: {
          connectionId: binding.connectionId,
          ...(binding.connectionGeneration
            ? { connectionGeneration: binding.connectionGeneration }
            : {}),
          ...(binding.catalogGeneration
            ? { catalogGeneration: binding.catalogGeneration }
            : {}),
        },
      };
      // Record the exact normalized request before forwarding; the provider
      // path takes the credential lease on the way through. The record is
      // keyed by an id this authority mints, so a Bot cannot overwrite one of
      // its own earlier records by reusing a `requestId`.
      const recordId = `model-request-${newId()}`;
      const record: IsolateModelRequestRecordV1 = {
        schemaVersion: 1,
        recordId,
        requestId: request.requestId,
        botId: options.botId,
        packageId: options.packageId,
        generationId: options.generationId,
        capabilityId: capability.capabilityId,
        request: forwarded,
        recordedAt: now().toISOString(),
      };
      await options.storage.put(
        `${ISOLATE_MODEL_REQUEST_PREFIX}${recordId}`,
        record,
      );
      const controller = new AbortController();
      const events = options.modelPath.stream(forwarded, controller.signal);
      return {
        status: "streaming",
        requestId: request.requestId,
        events: isolateModelEventStreamV1(events, controller),
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
 * The content address of every binding baked into an isolate's `env`: User,
 * Bot, and Composition generation from `IDENTITY` and the `CAPABILITIES` props,
 * plus the User-enabled capability set. A loader id is served from cache, so
 * any change must produce a different digest or a stale isolate will answer
 * under the wrong identity or authority. Identical artifacts share an isolate
 * only when all of these binding inputs are identical (AGENTS.md Package
 * composition; ADR 0019).
 */
export async function isolateBindingDigestV1(input: {
  userId: string;
  botId: string;
  generationId: string;
  capabilities: readonly IsolateCapabilityV1[];
}): Promise<string> {
  const ordered = [...input.capabilities]
    .map((capability) => ({
      packageId: capability.packageId,
      capabilityId: capability.capabilityId,
      kind: capability.kind,
      connectionId: capability.connectionId ?? null,
    }))
    .sort(
      (left, right) =>
        compareIsolateIdentifierV1(left.packageId, right.packageId) ||
        compareIsolateIdentifierV1(left.capabilityId, right.capabilityId) ||
        compareIsolateIdentifierV1(left.kind, right.kind) ||
        compareIsolateIdentifierV1(
          left.connectionId ?? "",
          right.connectionId ?? "",
        ),
    );
  return await sha256Hex(
    JSON.stringify({
      userId: input.userId,
      botId: input.botId,
      generationId: input.generationId,
      ordered,
    }),
  );
}

function compareIsolateIdentifierV1(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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
 */
export function createR2PackageArtifactStore(
  bucket: R2Bucket,
): BotIsolateArtifactStore {
  return {
    async loadPackageArtifact(contentHash: string): Promise<string> {
      const object = await bucket.get(`packages/${contentHash}.mjs`);
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
