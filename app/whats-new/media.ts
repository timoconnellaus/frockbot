import { WHATS_NEW_MEDIA_V1 } from "./media.generated.ts";

export const WHATS_NEW_MEDIA_MAX_BYTES_V1 = 200 * 1024;
export const WHATS_NEW_IMAGE_PATH_V1 =
  /^\/whats-new\/([a-z0-9][a-z0-9._-]{0,62}\.webp)$/;
const MEDIA_FILE_V1 = /^[a-z0-9][a-z0-9._-]{0,62}\.webp$/;

export function whatsNewMediaFileV1(file: string): string | undefined {
  return MEDIA_FILE_V1.test(file) ? file : undefined;
}

/** The file name a public What’s New image path names, or undefined. */
export function whatsNewImageNameV1(pathname: string): string | undefined {
  const match = WHATS_NEW_IMAGE_PATH_V1.exec(pathname);
  return match?.[1];
}

export function whatsNewMediaBytesV1(file: string): Uint8Array | undefined {
  const name = whatsNewMediaFileV1(file);
  if (!name) return undefined;
  const encoded = WHATS_NEW_MEDIA_V1[name];
  if (!encoded) return undefined;
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function whatsNewImageResponseV1(
  pathname: string,
): Response | undefined {
  const name = whatsNewImageNameV1(pathname);
  if (!name) return undefined;
  const bytes = whatsNewMediaBytesV1(name);
  if (!bytes) return new Response("Not found", { status: 404 });
  const body = new Uint8Array(bytes.byteLength);
  body.set(bytes);
  return new Response(body.buffer, {
    headers: {
      "content-type": "image/webp",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}
