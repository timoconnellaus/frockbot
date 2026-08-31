// The narrow image-model interface this Package consumes, and the models it
// knows how to ask for.
//
// "The kernel declares the narrow interfaces it consumes ... and owns no
// implementation of them." The same discipline applies one level down: this
// Package declares what it needs from an image model and implements none of
// it. The host — `apps/cloudflare` through `plugin-shell` — adapts Workers AI's
// `AI` binding to this shape, so no Cloudflare type and no provider response
// envelope reaches the tool.
//
// `run` answers raw image bytes, never base64 and never a provider envelope.
// Workers AI's text-to-image models disagree about which they return
// (`flux-1-schnell` answers `{ image: "<base64>" }`, the Stable Diffusion
// models answer a binary stream), and normalizing that is exactly the
// adapter's job.

/** The image model seam. One method, one direction, no provider vocabulary. */
export interface ImageModelV1 {
  run(model: string, input: ImageModelInputV1): Promise<ArrayBuffer>;
}

/**
 * What the tool asks for. `width` and `height` are a *request*: not every
 * Workers AI text-to-image model accepts them (`flux-1-schnell` does not), so
 * the tool reports the dimensions it decodes from the returned bytes rather
 * than echoing these back as if they were honoured.
 */
export interface ImageModelInputV1 {
  prompt: string;
  width: number;
  height: number;
}

/**
 * The default model. Cloudflare's own catalog calls FLUX.1 [schnell] the
 * fastest text-to-image model on Workers AI, and it is the one the parity
 * slice was specified against (`docs/plans/` slice O, §2). Overridable through
 * the `image.model` Package setting.
 */
export const DEFAULT_IMAGE_MODEL_V1 = "@cf/black-forest-labs/flux-1-schnell";

/**
 * The models the `image.model` setting accepts, mirroring the manifest's
 * `enum`. A model outside this list is refused rather than passed through: the
 * host binding would happily run an image-to-image or a text model and answer
 * something this tool cannot store.
 */
export const IMAGE_MODELS_V1: readonly string[] = [
  "@cf/black-forest-labs/flux-1-schnell",
  "@cf/black-forest-labs/flux-2-klein-4b",
  "@cf/stabilityai/stable-diffusion-xl-base-1.0",
  "@cf/bytedance/stable-diffusion-xl-lightning",
];

/** The setting's value, or the default; an unknown model is refused. */
export function resolveImageModelV1(configured?: string): string {
  const named = configured?.trim();
  if (!named) return DEFAULT_IMAGE_MODEL_V1;
  if (!IMAGE_MODELS_V1.includes(named)) {
    throw new Error(`image model "${named}" is not one this Package offers`);
  }
  return named;
}
