import { sha256HexBytesV1 } from "@frockbot/core/crypto";
import type { ComputerScreenshotV1 } from "@frockbot/computer/core/host";

/**
 * The one picture of a Bot's desktop the card shows when it is not streaming:
 * the newest frame, replaced by each new one.
 *
 * It lives in the Bot Durable Object's own storage, so it goes when the Bot
 * goes, and it is not a Workspace file: nothing lists it, versions it, syncs it
 * or prunes it. That is the point. Filing every frame as a durable file cost a
 * Computer call about fourteen seconds of listing and deleting, for pictures
 * the card could not even read.
 */
export const COMPUTER_FRAME_RECORD_KEY = "computer:frame:v1";

/**
 * The largest frame kept. A Durable Object value stops at 2 MiB, and the Fly
 * host already answers anything past this with a second read. A larger frame
 * is skipped and the previous one stays: the card showing an older picture is
 * better than a write that fails.
 */
export const COMPUTER_FRAME_MAX_BYTES = 1_500_000;

export interface StoredComputerFrameV1 {
  version: 1;
  bytes: Uint8Array;
  mediaType: "image/png";
  /** Hex SHA-256 of `bytes`; the frame's address in the card's URL. */
  contentHash: string;
  capturedAt: string;
}

/** Where the Computer Package puts the newest frame of one Bot's desktop. */
export interface ComputerFrameSinkV1 {
  put(frame: StoredComputerFrameV1): Promise<void>;
}

export interface ComputerFrameStorageV1 {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

/** The frame a capture makes, or undefined when it is too large to keep. */
export async function computerFrameFromCaptureV1(
  captured: ComputerScreenshotV1,
): Promise<StoredComputerFrameV1 | undefined> {
  if (captured.bytes.byteLength > COMPUTER_FRAME_MAX_BYTES) return undefined;
  return {
    version: 1,
    bytes: captured.bytes,
    mediaType: captured.mediaType,
    contentHash: await sha256HexBytesV1(captured.bytes),
    capturedAt: captured.capturedAt,
  };
}

export function computerFrameSinkV1(
  storage: ComputerFrameStorageV1,
): ComputerFrameSinkV1 {
  return {
    put: (frame) => storage.put(COMPUTER_FRAME_RECORD_KEY, frame),
  };
}

export function decodeStoredComputerFrameV1(
  value: unknown,
): StoredComputerFrameV1 {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("A stored Computer frame is an object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(",");
  if (keys !== "bytes,capturedAt,contentHash,mediaType,version") {
    throw new TypeError(`A stored Computer frame has unexpected keys: ${keys}`);
  }
  if (record.version !== 1) {
    throw new TypeError("A stored Computer frame is version 1");
  }
  if (!(record.bytes instanceof Uint8Array)) {
    throw new TypeError("A stored Computer frame holds bytes");
  }
  if (record.mediaType !== "image/png") {
    throw new TypeError("A stored Computer frame is a PNG");
  }
  if (
    typeof record.contentHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.contentHash)
  ) {
    throw new TypeError("A stored Computer frame names its SHA-256");
  }
  if (
    typeof record.capturedAt !== "string" ||
    Number.isNaN(Date.parse(record.capturedAt))
  ) {
    throw new TypeError("A stored Computer frame says when it was captured");
  }
  return {
    version: 1,
    bytes: record.bytes,
    mediaType: "image/png",
    contentHash: record.contentHash,
    capturedAt: record.capturedAt,
  };
}
