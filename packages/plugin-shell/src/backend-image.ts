// The Bot Durable Object's half of the image-generation seam.
//
// The Image Package consumes a narrow `ImageModelV1` — one method, answering
// raw image bytes — and knows nothing about Cloudflare's native AI binding. This module is the
// adapter: it takes the `AI` binding off the Durable Object's environment,
// normalizes the three shapes a native text-to-image model answers in, and
// hands the Package a seam with no platform vocabulary in it. "Electron,
// Cloudflare, provider SDK, and Computer implementation types remain inside
// their adapters."
//
// The binding is optional, exactly as `PACKAGE_BUNDLER` is. A deployment with
// no native AI binding still mounts the Package, and `generate_image` then
// refuses visibly on the Turn that calls it — which is a better answer than a
// tool that silently vanishes from the catalog, and a far better one than a
// `TypeError` inside the Agent loop.
//
// HIBERNATION. Nothing here reaches the Computer. The image lands in object
// storage through `WORKSPACE_FILES`, with its generation recorded in this
// Durable Object, so `generate_image` works with the Computer hibernated.
import type { WorkspaceFilesV1 } from "@frockbot/kernel-contracts";
import type { ImageRuntimeHostV1 } from "@frockbot/plugin-image/agent";
import type {
  ImageModelInputV1,
  ImageModelV1,
} from "@frockbot/plugin-image/model";

/** The Bot and User a generated image is attributed to. */
export interface BotImageIdentity {
  userId: string;
  botId: string;
}

/** The run, Turn and Session a generated image records as its provenance. */
export interface BotImageTurn {
  runId: string;
  turnId: string;
  sessionId: string;
}

/**
 * The native AI binding, declared structurally so this module names no
 * Cloudflare type it does not have to. `run` is the whole of what an image
 * model needs from it.
 */
export interface NativeAiBindingV1 {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

/**
 * The narrow slice of the Durable Object environment this module reads. Named
 * as its own type so the binding's absence is a typed state, not a cast.
 */
export interface BotImageEnv {
  AI?: NativeAiBindingV1;
  WORKSPACE_FILES?: WorkspaceFilesV1;
}

function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function readStream(
  stream: ReadableStream<Uint8Array>,
): Promise<ArrayBuffer> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined.buffer as ArrayBuffer;
}

/**
 * The bytes inside whatever a native text-to-image model answered.
 *
 * The catalog does not agree with itself: `flux-1-schnell` and the FLUX.2
 * models answer `{ image: "<base64>" }`, the Stable Diffusion models answer a
 * binary `ReadableStream`, and the binding may hand back an `ArrayBuffer`
 * directly. Every one of those is an image; none of them is the Package's
 * problem.
 */
export async function decodeNativeAiImageV1(
  answer: unknown,
): Promise<ArrayBuffer> {
  if (answer instanceof ArrayBuffer) return answer;
  if (ArrayBuffer.isView(answer)) {
    const view = answer as ArrayBufferView;
    return view.buffer.slice(
      view.byteOffset,
      view.byteOffset + view.byteLength,
    ) as ArrayBuffer;
  }
  if (answer instanceof ReadableStream) {
    return await readStream(answer as ReadableStream<Uint8Array>);
  }
  if (answer instanceof Response) {
    return await answer.arrayBuffer();
  }
  if (answer && typeof answer === "object") {
    const image = (answer as { image?: unknown }).image;
    if (typeof image === "string" && image.length > 0) {
      return decodeBase64(image).buffer as ArrayBuffer;
    }
  }
  throw new Error("the image model answered something that is not an image");
}

/**
 * The native AI binding as an {@link ImageModelV1}.
 *
 * `width` and `height` are passed through: the Stable Diffusion models accept
 * them, and the FLUX models ignore unknown fields rather than refusing. The
 * Package never trusts them to have been honoured — it reads the dimensions
 * back out of the bytes.
 */
export function createNativeAiImageModelV1(
  binding: NativeAiBindingV1,
): ImageModelV1 {
  return {
    async run(model: string, input: ImageModelInputV1): Promise<ArrayBuffer> {
      const answer = await binding.run(model, {
        prompt: input.prompt,
        width: input.width,
        height: input.height,
      });
      return await decodeNativeAiImageV1(answer);
    },
  };
}

/**
 * The image-generation seam one admitted Turn runs under, or `undefined` when
 * the Bot's Workspace file surface is unavailable.
 *
 * The Workspace is the hard requirement, not the model: an image with nowhere
 * durable to land is not a capability, while a missing model binding is a
 * refusal the Bot can read and report. So a host with a Workspace and no `AI`
 * still mounts the Package, with `model` absent.
 */
export function createBotImageHost(
  identity: BotImageIdentity,
  turn: BotImageTurn,
  env: object,
  modelId?: string,
): ImageRuntimeHostV1 | undefined {
  // SAFETY: the Workspace file surface is constructed onto the Durable Object
  // environment rather than declared in the generated `Env`, because it is not
  // a Worker binding. Absence is a supported state, not an error.
  const bindings = env as BotImageEnv;
  const files = bindings.WORKSPACE_FILES;
  if (!files) return undefined;
  return {
    owner: { userId: identity.userId, botId: identity.botId },
    writer: {
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      runId: turn.runId,
    },
    files,
    ...(bindings.AI ? { model: createNativeAiImageModelV1(bindings.AI) } : {}),
    ...(modelId ? { modelId } : {}),
  };
}
