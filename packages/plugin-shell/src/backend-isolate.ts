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
} from "@frockbot/kernel-contracts";
import { encodeIsolateModelEventLineV1 } from "@frockbot/kernel-contracts";
import type { BotIsolateArtifactStore } from "@frockbot/kernel-composition/isolate";

export type { IsolateModelBindingV1 } from "@frockbot/kernel-contracts";

export const BOT_ISOLATE_COMPATIBILITY_DATE = "2026-08-27";

export interface BotCapabilitiesPropsV1 {
  userId: string;
  botId: string;
  runId: string;
  sessionId: string;
  turnId: string;
  generationId: string;
  packageId: string;
  connections: IsolateConnectionV1[];
  model?: IsolateModelBindingV1;
  memory: boolean;
  workspace: boolean;
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

/**
 * A loaded isolate may receive only the Connection generation baked into its
 * admitted authority snapshot. A later User Connection change gets a new
 * binding digest and isolate identity; it must not leak through this old stub.
 */
export function matchesAdmittedConnectionV1(
  admitted: IsolateConnectionV1 | undefined,
  outcome: IsolateConnectionOutcomeV1,
): outcome is IsolateConnectionLeaseV1 {
  return (
    admitted !== undefined &&
    outcome.status === "available" &&
    outcome.connectionId === admitted.connectionId &&
    outcome.generation === admitted.generation
  );
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
        notify: true,
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
 * The content address of the bindings baked into a loaded isolate's env.
 *
 * Connection order is irrelevant; ids and generations are the authority
 * identity. User, Bot, the resolved model binding, and the pinned Composition
 * generation complete the digest. Package id is deliberately absent: two
 * Packages of one Bot receive the same authority projection.
 */
export async function isolateBindingDigestV1(input: {
  userId: string;
  botId: string;
  connections: readonly Pick<
    IsolateConnectionV1,
    "connectionId" | "generation"
  >[];
  model?: IsolateModelBindingV1;
  compositionGenerationId: string;
}): Promise<string> {
  const connections = [...input.connections]
    .map(({ connectionId, generation }) => ({ connectionId, generation }))
    .sort((left, right) => left.connectionId.localeCompare(right.connectionId));
  return await sha256Hex(
    JSON.stringify({
      userId: input.userId,
      botId: input.botId,
      compositionGenerationId: input.compositionGenerationId,
      connections,
      model: input.model ?? null,
    }),
  );
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
