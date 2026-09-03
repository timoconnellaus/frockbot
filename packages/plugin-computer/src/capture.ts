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
