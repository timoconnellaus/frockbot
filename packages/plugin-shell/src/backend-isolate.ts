// The Bot Durable Object half of the isolate capability boundary.
//
// A loaded Bot Package sees exactly two bindings: `IDENTITY` (a plain object)
// and `CAPABILITIES` (a loopback service binding). Every method behind
// `CAPABILITIES` ends up here, in the authority that owns the Bot's durable
// state — so an authority-widening request becomes a durable pending decision
// rather than a grant, and a model call records its normalized request and
// acquires its credential lease through the existing provider path before a
// single byte leaves the account.
import type {
  IsolateAuthorityRequestV1,
  IsolateCapabilityDescriptorV1,
  IsolateModelInvocationV1,
  IsolatePendingDecisionV1,
  LlmStreamEvent,
  NormalizedModelRequest,
} from "@frockbot/kernel-contracts";
import {
  decodeIsolateAuthorityRequestV1,
  encodeIsolateModelEventLineV1,
} from "@frockbot/kernel-contracts";
import type { BotIsolateArtifactStore } from "@frockbot/kernel-composition/isolate";

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
  /** Already resolved and filtered to enabled Assignments by the authority. */
  assignments: IsolateAssignmentV1[];
}

export const ISOLATE_DECISION_PREFIX = "isolate:decision:";
export const ISOLATE_MODEL_REQUEST_PREFIX = "isolate:model-request:";

/** A durable record that the Bot asked for authority it does not hold. */
export interface IsolatePendingAuthorityDecisionV1 {
  schemaVersion: 1;
  decisionId: string;
  botId: string;
  packageId: string;
  generationId: string;
  capabilityId: string;
  reason: string;
  requestedAt: string;
  status: "pending";
}

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

/** One enabled Assignment, already resolved the way `plugin-shell` resolves them. */
export interface IsolateAssignmentV1 {
  assignmentId: string;
  packageId: string;
  capabilityId: string;
  kind: IsolateCapabilityDescriptorV1["kind"];
  connectionId?: string;
  providerModelId?: string;
}

/**
 * The Bot's durable model binding, resolved by the authority from the Bot's
 * own configuration and the User's Connection — never from anything the Bot
 * supplied. An `invokeModel` request is authorized only when it names exactly
 * this provider and this model, and it is forwarded carrying exactly this
 * binding.
 */
export interface IsolateModelBindingV1 {
  assignmentId: string;
  packageId: string;
  capabilityId: string;
  connectionId: string;
  provider: string;
  providerModelId: string;
  connectionGeneration?: string;
  catalogGeneration?: string;
}

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
  /** Assignment-derived and nothing else. */
  assignments: readonly IsolateAssignmentV1[];
  /**
   * The one model binding this Bot durably holds, or absent when it holds
   * none. Absent means every model request is a pending decision.
   */
  modelBinding?: IsolateModelBindingV1;
  /** Absent when the Bot has no enabled model Assignment at all. */
  modelPath?: IsolateModelPath;
  now?(): Date;
  newId?(): string;
}

export interface IsolateCapabilityHost {
  list(): Promise<IsolateCapabilityDescriptorV1[]>;
  requestAuthority(request: unknown): Promise<IsolatePendingDecisionV1>;
  invokeModel(
    request: NormalizedModelRequest,
  ): Promise<IsolateModelInvocationV1>;
  pendingDecisions(): Promise<IsolatePendingAuthorityDecisionV1[]>;
  recordedModelRequests(): Promise<IsolateModelRequestRecordV1[]>;
}

/**
 * The enabled model Assignment that can serve this request, if any.
 *
 * An Assignment authorizes exactly one Package, one Connection, and one
 * provider model: the Bot's durable binding. A request naming any other
 * provider or model resolves to nothing, whatever the Bot claims about it —
 * the Bot-supplied `modelBinding` is never read here or anywhere downstream.
 */
export function matchingModelAssignmentV1(
  assignments: readonly IsolateAssignmentV1[],
  binding: IsolateModelBindingV1 | undefined,
  request: NormalizedModelRequest,
): IsolateAssignmentV1 | undefined {
  if (!binding) return undefined;
  if (
    request.provider !== binding.provider ||
    request.model !== binding.providerModelId
  ) {
    return undefined;
  }
  return assignments.find(
    (assignment) =>
      assignment.kind === "model" &&
      assignment.assignmentId === binding.assignmentId &&
      assignment.packageId === binding.packageId &&
      assignment.capabilityId === binding.capabilityId &&
      assignment.connectionId === binding.connectionId &&
      assignment.providerModelId === binding.providerModelId,
  );
}

export function createIsolateCapabilityHost(
  options: IsolateCapabilityHostOptions,
): IsolateCapabilityHost {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => crypto.randomUUID());

  async function recordDecision(
    capabilityId: string,
    reason: string,
  ): Promise<IsolatePendingDecisionV1> {
    const decisionId = `decision-${newId()}`;
    const record: IsolatePendingAuthorityDecisionV1 = {
      schemaVersion: 1,
      decisionId,
      botId: options.botId,
      packageId: options.packageId,
      generationId: options.generationId,
      capabilityId,
      reason,
      requestedAt: now().toISOString(),
      status: "pending",
    };
    await options.storage.put(
      `${ISOLATE_DECISION_PREFIX}${decisionId}`,
      record,
    );
    return { status: "pending-user-decision", decisionId };
  }

  return {
    list(): Promise<IsolateCapabilityDescriptorV1[]> {
      return Promise.resolve(
        options.assignments.map((assignment) => ({
          capabilityId: assignment.capabilityId,
          kind: assignment.kind,
        })),
      );
    },

    async requestAuthority(
      request: unknown,
    ): Promise<IsolatePendingDecisionV1> {
      const decoded: IsolateAuthorityRequestV1 =
        decodeIsolateAuthorityRequestV1(request);
      // Self-modification never widens authority, even when the capability is
      // already assigned: the answer is a decision the User makes.
      return await recordDecision(decoded.capabilityId, decoded.reason);
    },

    async invokeModel(
      request: NormalizedModelRequest,
    ): Promise<IsolateModelInvocationV1> {
      if (request.requestId.length > MAX_ISOLATE_REQUEST_ID) {
        throw new Error("isolate model request requestId is not bounded");
      }
      const binding = options.modelBinding;
      const assignment = matchingModelAssignmentV1(
        options.assignments,
        binding,
        request,
      );
      if (!assignment || !binding || !options.modelPath) {
        return await recordDecision(
          `models:${request.provider}:${request.model}`,
          `Bot Package "${options.packageId}" asked to invoke a model with no matching enabled Assignment`,
        );
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
        capabilityId: assignment.capabilityId,
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

    async pendingDecisions(): Promise<IsolatePendingAuthorityDecisionV1[]> {
      const stored =
        await options.storage.list<IsolatePendingAuthorityDecisionV1>({
          prefix: ISOLATE_DECISION_PREFIX,
        });
      return [...stored.values()];
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
 * The content address of the bindings an isolate is loaded with: its
 * Assignments and the Composition generation whose `CAPABILITIES` stub is
 * baked into its `env`. A loader id is served from cache, so a Bot whose
 * Assignments change must get a different isolate rather than one that keeps a
 * revoked binding — and a new generation must get a different isolate rather
 * than one whose `env` still names the generation it was first loaded under.
 * Both are bindings the isolate was granted, so both belong in this digest and
 * the loader id stays derived from the artifact set and the binding digest
 * alone.
 */
export async function isolateBindingDigestV1(
  assignments: readonly IsolateAssignmentV1[],
  generationId: string,
): Promise<string> {
  const ordered = [...assignments]
    .map((assignment) => ({
      assignmentId: assignment.assignmentId,
      packageId: assignment.packageId,
      capabilityId: assignment.capabilityId,
      kind: assignment.kind,
      connectionId: assignment.connectionId ?? null,
      providerModelId: assignment.providerModelId ?? null,
    }))
    .sort((left, right) => left.assignmentId.localeCompare(right.assignmentId));
  return await sha256Hex(JSON.stringify({ generationId, ordered }));
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
