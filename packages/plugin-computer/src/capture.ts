import {
  ComputerError,
  type ComputerHandle,
  type ComputerScreenshotV1,
} from "@frockbot/computer-core";
import type {
  WorkspaceFilesV1,
  WorkspaceGenerationV1,
  WorkspacePathV1,
  WorkspaceRootV1,
  WorkspaceWriterV1,
} from "@frockbot/kernel-contracts";
import { COMPUTER_SCREENSHOT_RETENTION } from "./roots.js";

export type ComputerProjectionFileKindV1 = "screenshots" | "doctor";

/**
 * The shortest gap between two progress captures of the same desktop.
 *
 * A Turn can run a dozen Computer actions a second, and each capture crosses
 * a service binding to the Sprite and writes durable bytes. Two seconds is
 * fast enough that the card looks like it is following the Bot and slow
 * enough that a busy Turn does not spend itself photographing a screen.
 */
export const COMPUTER_PROGRESS_CAPTURE_INTERVAL_MS = 2_000;

/**
 * Decides whether the next Computer action gets a fresh capture filed for it.
 *
 * Turn-end captures do not ask: the last frame of a Turn is the one the card
 * will show for as long as the Bot is idle, so it is always filed. Everything
 * inside the Turn is progress, and progress is debounced.
 */
export interface ComputerCaptureCadenceV1 {
  /** True at most once per interval; records the admission when it grants. */
  admit(now: number): boolean;
  /** Forgets the last admission, so the next call grants immediately. */
  reset(): void;
}

export function createComputerCaptureCadenceV1(options?: {
  intervalMs?: number;
}): ComputerCaptureCadenceV1 {
  const intervalMs =
    options?.intervalMs ?? COMPUTER_PROGRESS_CAPTURE_INTERVAL_MS;
  let lastAdmittedAt: number | undefined;
  return {
    admit(now: number): boolean {
      // A clock that went backwards is not a licence to stop capturing; the
      // gap is measured forwards only.
      if (
        lastAdmittedAt !== undefined &&
        now >= lastAdmittedAt &&
        now - lastAdmittedAt < intervalMs
      ) {
        return false;
      }
      lastAdmittedAt = now;
      return true;
    },
    reset(): void {
      lastAdmittedAt = undefined;
    },
  };
}

/** Invalidates files projected by one resident Bot Durable Object. */
export interface ComputerProjectionFileInvalidationV1 {
  invalidate(botId: string, kind: ComputerProjectionFileKindV1): void;
}

export interface FiledComputerScreenshotV1 {
  captured: ComputerScreenshotV1;
  path: WorkspacePathV1;
  generation: WorkspaceGenerationV1;
}

/**
 * Keeps the newest captures for one Bot.
 *
 * Pruning is best effort: a capture that was recorded is never failed because
 * an older one could not be removed.
 */
async function pruneComputerScreenshotsV1(
  workspace: WorkspaceFilesV1,
  root: WorkspaceRootV1,
  botKey: string,
  writer: WorkspaceWriterV1,
): Promise<void> {
  const listed = await workspace.list({
    root,
    prefix: botKey,
    limit: COMPUTER_SCREENSHOT_RETENTION * 4,
  });
  if (listed.status !== "ok") return;
  const sorted = [...listed.entries].sort((left, right) => {
    const order = left.generation.writtenAt.localeCompare(
      right.generation.writtenAt,
    );
    return order !== 0 ? order : left.path.path.localeCompare(right.path.path);
  });
  const excess = sorted.length - COMPUTER_SCREENSHOT_RETENTION;
  for (let index = 0; index < excess; index += 1) {
    const entry = sorted[index]!;
    await workspace.delete({
      path: entry.path,
      writer,
      expectedGenerationId: entry.generation.generationId,
    });
  }
}

/**
 * The one capture-and-file path used by explicit, viewer-close, and Turn-end
 * screenshots. The caller supplies the honest actor and an actor-shaped path;
 * this function owns capability checks, capture, the durable write, and
 * retention.
 */
export async function fileComputerScreenshotV1(input: {
  computer: ComputerHandle;
  workspace: WorkspaceFilesV1;
  path: WorkspacePathV1;
  writer: WorkspaceWriterV1;
  botKey: string;
  effectId: string;
  signal?: AbortSignal;
}): Promise<FiledComputerScreenshotV1> {
  if (!input.computer.screenshot) {
    throw new ComputerError(
      "capability-unavailable",
      "The selected Computer does not support screenshots",
    );
  }
  const captured = await input.computer.screenshot.capture({
    effectId: input.effectId,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const written = await input.workspace.write({
    path: input.path,
    bytes: captured.bytes,
    writer: input.writer,
    expectedGenerationId: null,
    mediaType: captured.mediaType,
  });
  if (written.status !== "ok") {
    throw new Error(
      `The screenshot could not be filed: ${written.status}: ${written.reason}`,
    );
  }
  await pruneComputerScreenshotsV1(
    input.workspace,
    input.path.root,
    input.botKey,
    input.writer,
  );
  return { captured, path: input.path, generation: written.generation };
}
