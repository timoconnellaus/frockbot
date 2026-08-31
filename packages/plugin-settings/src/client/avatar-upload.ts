// Turning a picked file into an avatar upload command's payload.
//
// It lives outside the Vue component so the rules a User meets — which image
// types are accepted and how large one may be — are the same rules the tests
// exercise, and so the component holds only the file-picker wiring.
import {
  BOT_AVATAR_CONTENT_TYPES,
  BOT_AVATAR_MAX_BYTES,
  type BotAvatarContentTypeV1,
} from "@frockbot/configuration-core";

/** The `accept` attribute matching the content types the backend admits. */
export const BOT_AVATAR_ACCEPT = BOT_AVATAR_CONTENT_TYPES.join(",");

export interface AvatarUploadPayload {
  contentType: BotAvatarContentTypeV1;
  bytes: string;
}

export class AvatarUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AvatarUploadError";
  }
}

function encodeBase64(bytes: Uint8Array): string {
  // Chunked so a multi-megabyte avatar never blows the argument limit.
  const chunk = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

/**
 * Validates a picked image and encodes it for the avatar upload command. The
 * same bounds are enforced again at the backend seam; this pass exists so the
 * User is told what is wrong before a five-megabyte request is sent.
 */
export function prepareAvatarUpload(input: {
  contentType: string;
  bytes: Uint8Array;
}): AvatarUploadPayload {
  if (
    !(BOT_AVATAR_CONTENT_TYPES as readonly string[]).includes(input.contentType)
  ) {
    throw new AvatarUploadError(
      `Choose a PNG, JPEG, WebP, GIF, or SVG image (got ${input.contentType || "an unknown type"})`,
    );
  }
  if (input.bytes.length === 0) {
    throw new AvatarUploadError("That image file is empty");
  }
  if (input.bytes.length > BOT_AVATAR_MAX_BYTES) {
    throw new AvatarUploadError(
      `That image is ${Math.ceil(input.bytes.length / 1_048_576)} MB; the limit is ${BOT_AVATAR_MAX_BYTES / 1_048_576} MB`,
    );
  }
  return {
    contentType: input.contentType as BotAvatarContentTypeV1,
    bytes: encodeBase64(input.bytes),
  };
}

/**
 * The URL the served avatar route answers, keyed by digest so a replaced
 * avatar is fetched again instead of read from cache.
 */
export function botAvatarUrl(botId: string, digest: string): string {
  return `/api/bots/${encodeURIComponent(botId)}/avatar?v=${encodeURIComponent(digest)}`;
}
