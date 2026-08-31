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

/** The enabled model Assignment that can serve this request, if any. */
export function matchingModelAssignmentV1(
  assignments: readonly IsolateAssignmentV1[],
  request: NormalizedModelRequest,
): IsolateAssignmentV1 | undefined {
  return assignments.find(
    (assignment) =>
      assignment.kind === "model" &&
      (assignment.providerModelId === undefined ||
        assignment.providerModelId === request.model) &&
      (request.modelBinding?.connectionId === undefined ||
        assignment.connectionId === request.modelBinding.connectionId),
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
      const assignment = matchingModelAssignmentV1(
        options.assignments,
        request,
      );
      if (!assignment || !options.modelPath) {
        return await recordDecision(
          `models:${request.provider}:${request.model}`,
          `Bot Package "${options.packageId}" asked to invoke a model with no matching enabled Assignment`,
        );
      }
      // Record the exact normalized request before forwarding; the provider
      // path takes the credential lease on the way through.
      const record: IsolateModelRequestRecordV1 = {
        schemaVersion: 1,
        requestId: request.requestId,
        botId: options.botId,
        packageId: options.packageId,
        generationId: options.generationId,
        capabilityId: assignment.capabilityId,
        request: structuredClone(request),
        recordedAt: now().toISOString(),
      };
      await options.storage.put(
        `${ISOLATE_MODEL_REQUEST_PREFIX}${request.requestId}`,
        record,
      );
      const controller = new AbortController();
      const events = options.modelPath.stream(request, controller.signal);
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
      } catch (error) {
        stream.error(error);
      }
    },
    cancel(reason) {
      controller?.abort(reason);
      return iterator.return?.(undefined).then(() => undefined);
    },
  });
}

/**
 * The content address of the Assignment-derived bindings an isolate is loaded
 * with. A loader id is served from cache, so a Bot whose Assignments change
 * must get a different isolate rather than one that keeps a revoked binding.
 */
export async function isolateBindingDigestV1(
  assignments: readonly IsolateAssignmentV1[],
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
  return await sha256Hex(JSON.stringify(ordered));
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
