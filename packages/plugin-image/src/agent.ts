// The image-generation runtime Contribution: one tool, `generate_image`.
//
// It has no authority of its own and holds no credential. It receives a narrow
// {@link ImageModelV1} the host adapted from a platform binding, and the
// `WorkspaceFilesV1` the Bot Durable Object already constructs, and it turns
// one prompt into one durable, attributed file.
//
// Three constitutional rules shape everything below.
//
//  1. "Record durable execution intent before invoking an external side
//     effect. Only effects an interface declares read-only are exempt."
//     Generating an image is billed and durable, so `image/generate-intent` is
//     appended *and flushed* before the model is called, and `image/generated`
//     after the Workspace write settles. This is the `skill/write-intent` /
//     `skill/written` pattern, verbatim.
//  2. "Recovery never silently duplicates ... tool calls". The tool is
//     `idempotent: false`, so the registry will never re-run it to settle an
//     open effect; it must answer through `reconcile`, which reads the
//     effect-keyed object out of the Workspace and never calls the model.
//  3. "Failures are observable through durable state". Every refusal is an
//     `isError: true` result with a stable reason, never a throw.
//
// The durable `tool/result` is stable JSON naming the stored object — a path,
// a generation and a content hash. Image bytes never enter the event log:
// `SessionEventMap["tool/result"].content` is a string that is replayed into
// every later model request of the Turn, so a base64 image there would be
// re-sent on every step and would make the log unreadable. A reader that wants
// the pixels reads the Workspace file the result names.
//
// HIBERNATION. Nothing here reaches the Computer registry or a Computer
// provider. The Workspace surface is object storage with generations recorded
// in the Bot's Durable Object, so `generate_image` works with the Computer
// hibernated, exactly as Skills and Memory do.
import type {
  Session,
  SessionEvent,
  ToolDefinition,
  ToolEffectReconciliation,
  ToolExecutionContext,
  ToolExecutionResult,
  TurnTypeV1,
  WorkspaceFilesV1,
  WorkspacePathV1,
  WorkspaceWriteRequestV1,
} from "@frockbot/kernel-contracts";
import { WORKSPACE_MAX_FILE_BYTES } from "@frockbot/kernel-contracts";
// Merges the Agent loop's event declarations into the cordis Context type.
import type {} from "@frockbot/kernel-agent-loop/agent";
import type { Plugin } from "cordis";
import {
  decodeImageDimensionsV1,
  sha256HexOfTextV1,
  sha256HexV1,
  type ImageDimensionsV1,
} from "./bytes.js";
import {
  resolveImageModelV1,
  type ImageModelV1,
  type ImageModelInputV1,
} from "./model.js";
import {
  generatedImagePathV1,
  imageExtensionV1,
  IMAGE_GENERATED_ROOT_ID_V1,
  IMAGE_PACKAGE_ID_V1,
  type ImageOwnerV1,
} from "./root.js";

/**
 * The turn types the manifest's `image-generation` Capability admits, and
 * therefore the durable ceiling this Contribution registers under. Image
 * generation is a work tool on every turn type (`docs/research/
 * grokbot-computer.md` row 47, `buildTurnTools`), and the two must agree: the
 * ceiling here is the manifest's `admission.turnTypes` restated as code the
 * registry can read at mount time.
 */
export const IMAGE_TOOL_SUBAGENT_ROLES: readonly string[] = ["executor"];

export const IMAGE_TOOL_TURN_TYPES: readonly TurnTypeV1[] = [
  "chat",
  "automation",
  "subagent",
];

/** The longest prompt `generate_image` accepts. */
export const IMAGE_PROMPT_MAX_LENGTH = 2_000;
/** The only sizes the tool asks a model for. */
export const IMAGE_SIZES_V1: readonly number[] = [512, 1024];
/** The longest a generation may take before the tool gives up on it. */
export const IMAGE_GENERATION_TIMEOUT_MS = 60_000;
/**
 * The most image the tool will hold in memory before refusing.
 *
 * The Workspace's own bound is smaller ({@link WORKSPACE_MAX_FILE_BYTES}, one
 * mebibyte), and a file above it is refused by the store with its own reason.
 * This larger cap exists one layer earlier, so a runaway response is dropped
 * before it is hashed and decoded rather than after.
 */
export const IMAGE_MAX_RESPONSE_BYTES = 4 * 1_048_576;

/** The run, Turn and Session a generated image records as its provenance. */
export interface ImageWriterIdentityV1 {
  sessionId: string;
  turnId: string;
  runId: string;
}

/**
 * The host seam this Package receives, supplied by the Bot Durable Object for
 * one admitted Turn.
 *
 * `model` absent is a supported state, not an error: a deployment with no
 * Workers AI binding mounts the Package with none, and `generate_image`
 * refuses visibly rather than the tool vanishing from the catalog without
 * explanation. `files` absent is the same answer about the Workspace.
 */
export interface ImageRuntimeHostV1 {
  owner: ImageOwnerV1;
  writer: ImageWriterIdentityV1;
  /** The adapted platform binding. Absent on a host that has none. */
  model?: ImageModelV1;
  /** The Workspace file surface generated images are written through. */
  files?: WorkspaceFilesV1;
  /**
   * The `image.model` Package setting's value. Absent resolves to
   * {@link DEFAULT_IMAGE_MODEL_V1}.
   */
  modelId?: string;
}

const GENERATE_IMAGE_INPUT_SCHEMA = {
  type: "object",
  properties: {
    prompt: {
      type: "string",
      description:
        "What to draw, in words. Describe the subject, the composition and the style; the model sees nothing else.",
      maxLength: IMAGE_PROMPT_MAX_LENGTH,
    },
    width: {
      type: "integer",
      enum: [512, 1024],
      description: "Requested width in pixels. Some models ignore it.",
    },
    height: {
      type: "integer",
      enum: [512, 1024],
      description: "Requested height in pixels. Some models ignore it.",
    },
    n: {
      type: "integer",
      enum: [1],
      description: "How many images to generate. Only one per call.",
    },
  },
  required: ["prompt"],
  additionalProperties: false,
} as const;

interface GenerateImageInputV1 {
  prompt: string;
  width: number;
  height: number;
}

/** C0 controls and DEL: never valid in a prompt the Bot typed. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export function decodeGenerateImageInputV1(
  input: unknown,
): GenerateImageInputV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("generate_image input must be an object");
  }
  const value = input as Record<string, unknown>;
  const allowed = ["prompt", "width", "height", "n"];
  if (!Object.keys(value).every((key) => allowed.includes(key))) {
    throw new Error("generate_image input has unknown fields");
  }
  const prompt = value.prompt;
  if (
    typeof prompt !== "string" ||
    prompt.trim().length === 0 ||
    prompt.length > IMAGE_PROMPT_MAX_LENGTH ||
    CONTROL_CHARACTERS.test(prompt)
  ) {
    throw new Error(
      `generate_image prompt must be 1 to ${IMAGE_PROMPT_MAX_LENGTH} printable characters`,
    );
  }
  const size = (key: "width" | "height"): number => {
    const candidate = value[key];
    if (candidate === undefined) return 1024;
    if (typeof candidate !== "number" || !IMAGE_SIZES_V1.includes(candidate)) {
      throw new Error(
        `generate_image ${key} must be one of ${IMAGE_SIZES_V1.join(", ")}`,
      );
    }
    return candidate;
  };
  if (value.n !== undefined && value.n !== 1) {
    throw new Error("generate_image generates exactly one image per call");
  }
  return {
    prompt: prompt.trim(),
    width: size("width"),
    height: size("height"),
  };
}

/** The durable `tool/result` payload. Stable JSON, never prose, never bytes. */
export interface GenerateImageResultV1 {
  path: string;
  root: string;
  generationId: string;
  contentHash: string;
  mimeType: string;
  width: number;
  height: number;
}

/** The root name the result reports, so a reader can find the file. */
export const IMAGE_RESULT_ROOT_V1 = `package-declared:${IMAGE_PACKAGE_ID_V1}/${IMAGE_GENERATED_ROOT_ID_V1}`;

function refusal(reason: string): ToolExecutionResult {
  return { content: `generate_image was refused: ${reason}`, isError: true };
}

function success(result: GenerateImageResultV1): ToolExecutionResult {
  return { content: JSON.stringify(result), isError: false };
}

/** The turn and step an image event belongs to, read from the open step. */
export function openImageTurnPositionV1(session: Session): {
  turn: number;
  step: number;
} {
  const started = session.events.findLast(
    (event) => event.type === "step/start",
  );
  if (started?.type !== "step/start") {
    throw new Error("a generated image has no open step to record against");
  }
  return { turn: started.turn, step: started.step };
}

/**
 * The turn and step a *reconciliation* records against: the ones its own
 * intent event named. Reconciliation runs while resuming, when the step that
 * opened the effect may already be closed, so the open-step rule of
 * {@link openImageTurnPositionV1} would refuse a position that plainly exists
 * in the log.
 */
function recordedIntentPositionV1(
  session: Session,
  effectId: string,
): { turn: number; step: number } | undefined {
  const intent = session.events.findLast(
    (event): event is SessionEvent<"image/generate-intent"> =>
      event.type === "image/generate-intent" && event.effectId === effectId,
  );
  return intent ? { turn: intent.turn, step: intent.step } : undefined;
}

function alreadyRecorded(session: Session, effectId: string): boolean {
  return session.events.some(
    (event) => event.type === "image/generated" && event.effectId === effectId,
  );
}

async function withTimeout<T>(
  work: Promise<T>,
  milliseconds: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The two containers an effect could have landed as, newest naming first. */
function candidatePathsV1(
  owner: ImageOwnerV1,
  effectId: string,
): WorkspacePathV1[] {
  return ["png", "jpg"].map((extension) =>
    generatedImagePathV1(owner, effectId, extension),
  );
}

function resultFor(
  path: WorkspacePathV1,
  generationId: string,
  contentHash: string,
  dimensions: ImageDimensionsV1,
): GenerateImageResultV1 {
  return {
    path: path.path,
    root: IMAGE_RESULT_ROOT_V1,
    generationId,
    contentHash,
    mimeType: dimensions.mimeType,
    width: dimensions.width,
    height: dimensions.height,
  };
}

export function createGenerateImageTool(
  host: ImageRuntimeHostV1,
  sessions: { get(sessionId: string): Session | undefined },
): ToolDefinition {
  return {
    name: "generate_image",
    // A general work tool: the full toolset an `executor` subagent gets, and
    // not part of the narrow reach of `browserUse`, `computerUse`, or the two
    // video roles. See `@frockbot/plugin-subagents` `SUBAGENT_TOOL_REACH_V1`.
    admission: { subagentRoles: ["executor"] },
    description:
      "Generate one image from a text prompt and store it in your Workspace. Answers the file's path, content hash and size — not the image bytes; read the path to see the picture.",
    inputSchema: GENERATE_IMAGE_INPUT_SCHEMA as unknown as Record<
      string,
      unknown
    >,
    // Billed and durable. The registry never retries a non-idempotent effect;
    // it settles this one through `reconcile` below.
    idempotent: false,
    validate: (input: unknown) => {
      try {
        decodeGenerateImageInputV1(input);
        return true;
      } catch {
        return false;
      }
    },
    execute: async (
      input: unknown,
      context: ToolExecutionContext,
    ): Promise<ToolExecutionResult> => {
      let decoded: GenerateImageInputV1;
      try {
        decoded = decodeGenerateImageInputV1(input);
      } catch (error) {
        return refusal(error instanceof Error ? error.message : String(error));
      }
      if (!host.model) {
        return refusal(
          "this deployment has no image model binding, so no image can be generated here",
        );
      }
      if (!host.files) {
        return refusal(
          "the Workspace file surface is unavailable, so a generated image could not be stored",
        );
      }
      let modelId: string;
      try {
        modelId = resolveImageModelV1(host.modelId);
      } catch (error) {
        return refusal(error instanceof Error ? error.message : String(error));
      }
      const session = sessions.get(context.sessionId);
      if (!session) {
        return refusal(
          `session "${context.sessionId}" is unavailable, so the intent cannot be recorded`,
        );
      }
      let position: { turn: number; step: number };
      try {
        position = openImageTurnPositionV1(session);
      } catch (error) {
        return refusal(error instanceof Error ? error.message : String(error));
      }

      const effectId = context.effectId;
      const promptHash = await sha256HexOfTextV1(decoded.prompt);
      // Intent before effect, durable before the call.
      session.append({
        type: "image/generate-intent",
        ...position,
        effectId,
        model: modelId,
        promptHash,
        width: decoded.width,
        height: decoded.height,
      });
      await session.flush();

      const request: ImageModelInputV1 = {
        prompt: decoded.prompt,
        width: decoded.width,
        height: decoded.height,
      };
      let buffer: ArrayBuffer;
      try {
        buffer = await withTimeout(
          host.model.run(modelId, request),
          IMAGE_GENERATION_TIMEOUT_MS,
          `image model "${modelId}"`,
        );
      } catch (error) {
        return refusal(
          `the image model failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const bytes = new Uint8Array(buffer);
      if (bytes.byteLength === 0) {
        return refusal("the image model returned no bytes");
      }
      if (bytes.byteLength > IMAGE_MAX_RESPONSE_BYTES) {
        return refusal(
          `the image model returned ${bytes.byteLength} bytes, over the ${IMAGE_MAX_RESPONSE_BYTES} byte cap`,
        );
      }
      if (bytes.byteLength > WORKSPACE_MAX_FILE_BYTES) {
        return refusal(
          `the generated image is ${bytes.byteLength} bytes and a Workspace file may not exceed ${WORKSPACE_MAX_FILE_BYTES}; ask for a smaller size`,
        );
      }
      const dimensions = decodeImageDimensionsV1(bytes);
      if (!dimensions) {
        return refusal(
          "the image model returned bytes that are neither a PNG nor a JPEG",
        );
      }

      const contentHash = await sha256HexV1(bytes);
      const path = generatedImagePathV1(
        host.owner,
        effectId,
        imageExtensionV1(dimensions.mimeType),
      );
      const write: WorkspaceWriteRequestV1 = {
        path,
        bytes,
        writer: {
          kind: "bot",
          botId: host.owner.botId,
          sessionId: host.writer.sessionId,
          turnId: host.writer.turnId,
          runId: host.writer.runId,
        },
        // The path is keyed by this effect, so nothing may already hold it. A
        // conflict means a previous attempt at *this* effect already wrote the
        // object, which reconciliation — not a second write — settles.
        expectedGenerationId: null,
        mediaType: dimensions.mimeType,
      };
      const outcome = await host.files.write(write);
      if (outcome.status !== "ok") {
        if (outcome.status === "conflict") {
          const recovered = await readRecordedImage(host, effectId);
          if (recovered) {
            return await recordGenerated(
              session,
              position,
              effectId,
              modelId,
              recovered,
            );
          }
        }
        return refusal(
          `the generated image could not be stored: the write was ${outcome.status} (${outcome.reason})`,
        );
      }
      return await recordGenerated(session, position, effectId, modelId, {
        path,
        generationId: outcome.generation.generationId,
        contentHash,
        dimensions,
      });
    },
    /**
     * Settles an effect an interrupted Turn left open, without generating —
     * and therefore without billing — a second image. The effect-keyed object
     * is the whole answer: present means the generation happened and reached
     * durable storage; absent means it did not, and the Turn is told so rather
     * than being handed a silent retry.
     */
    reconcile: async (
      _input: unknown,
      context: ToolExecutionContext,
    ): Promise<ToolEffectReconciliation> => {
      if (!host.files) {
        return {
          status: "unavailable",
          reason:
            "the Workspace file surface is unavailable, so a generated image cannot be recovered",
        };
      }
      const effectId = context.effectId;
      const recovered = await readRecordedImage(host, effectId);
      if (!recovered) {
        return {
          status: "unavailable",
          reason: `no generated image is stored for effect "${effectId}"`,
        };
      }
      let modelId = host.modelId ?? "";
      try {
        modelId = resolveImageModelV1(host.modelId);
      } catch {
        // The setting drifted since the effect opened. The recovered object is
        // still the effect's outcome; the model name is only a label here.
      }
      const session = sessions.get(context.sessionId);
      const position = session
        ? recordedIntentPositionV1(session, effectId)
        : undefined;
      if (session && position && !alreadyRecorded(session, effectId)) {
        const result = await recordGenerated(
          session,
          position,
          effectId,
          modelId,
          recovered,
        );
        return { status: "recovered", result };
      }
      return {
        status: "recovered",
        result: success(
          resultFor(
            recovered.path,
            recovered.generationId,
            recovered.contentHash,
            recovered.dimensions,
          ),
        ),
      };
    },
  };
}

interface RecordedImageV1 {
  path: WorkspacePathV1;
  generationId: string;
  contentHash: string;
  dimensions: ImageDimensionsV1;
}

/** The object this effect wrote, read back from the Workspace, or nothing. */
async function readRecordedImage(
  host: ImageRuntimeHostV1,
  effectId: string,
): Promise<RecordedImageV1 | undefined> {
  const files = host.files;
  if (!files) return undefined;
  for (const path of candidatePathsV1(host.owner, effectId)) {
    const outcome = await files.read(path);
    if (outcome.status !== "ok") continue;
    const dimensions = decodeImageDimensionsV1(outcome.file.bytes);
    if (!dimensions) continue;
    return {
      path,
      generationId: outcome.file.generation.generationId,
      contentHash: outcome.file.generation.contentHash,
      dimensions,
    };
  }
  return undefined;
}

/** Appends `image/generated`, flushes it, and answers the durable result. */
async function recordGenerated(
  session: Session,
  position: { turn: number; step: number },
  effectId: string,
  modelId: string,
  recorded: RecordedImageV1,
): Promise<ToolExecutionResult> {
  const result = resultFor(
    recorded.path,
    recorded.generationId,
    recorded.contentHash,
    recorded.dimensions,
  );
  session.append({
    type: "image/generated",
    ...position,
    effectId,
    model: modelId,
    path: result.path,
    generationId: result.generationId,
    contentHash: result.contentHash,
    mimeType: result.mimeType,
    width: result.width,
    height: result.height,
  });
  // The model must not be told the image exists before the record is durable.
  await session.flush();
  return success(result);
}

/**
 * The runtime Contribution. Registers `generate_image` on every turn type —
 * it is a work tool, and the parity register puts image generation on
 * automation turns as well as chat ones (`docs/research/grokbot-computer.md`
 * row 47). The manifest's `admission` ceiling is what bounds it durably; the
 * definition declares none, which the kernel reads as "all of them".
 */
export function createImageRuntimePlugin(
  host: ImageRuntimeHostV1,
): Plugin.Function {
  const plugin: Plugin.Function = (ctx) => {
    const dispose = ctx.tools.register(
      createGenerateImageTool(host, ctx.sessions),
      {
        admissionCeiling: IMAGE_TOOL_TURN_TYPES,
        subagentRoleCeiling: IMAGE_TOOL_SUBAGENT_ROLES,
      },
    );
    return () => dispose();
  };
  plugin.inject = ["tools", "sessions"];
  return plugin;
}
