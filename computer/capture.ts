import { ComputerError } from "@frockbot/computer/core";
import {
  type ComputerHostSessionV1,
  type ComputerScreenshotV1,
} from "@frockbot/computer/core/host";
import type {
  ComputerCaptureTimingV1,
  WorkspaceFilesV1,
  WorkspaceGenerationV1,
  WorkspacePathV1,
  WorkspaceRootV1,
  WorkspaceWriterV1,
} from "@frockbot/core/contracts";
import {
  computerFrameFromCaptureV1,
  type ComputerFrameSinkV1,
  type StoredComputerFrameV1,
} from "./frame.js";
import { COMPUTER_SCREENSHOT_RETENTION } from "./roots.js";

export type ComputerProjectionFileKindV1 = "frame" | "doctor";

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
 * Keeps the newest explicit captures for one Bot, off the tool call: the Turn
 * end runs it once for every capture the Turn filed.
 *
 * Best effort, and it stops at the first removal that does not go through:
 * a delete refused once is refused again, and retrying it would only spend
 * the Turn's closing seconds on the same file.
 */
export async function pruneComputerScreenshotsV1(input: {
  workspace: WorkspaceFilesV1;
  root: WorkspaceRootV1;
  botKey: string;
  writer: WorkspaceWriterV1;
  timing?: ComputerCaptureTimingV1;
  now?: () => number;
}): Promise<void> {
  const step = captureStepTimerV1(input.timing, input.now ?? Date.now);
  const listed = await step("list", () =>
    input.workspace.list({
      root: input.root,
      prefix: input.botKey,
      limit: COMPUTER_SCREENSHOT_RETENTION * 4,
    }),
  );
  if (listed.status !== "ok") return;
  const sorted = [...listed.entries].sort((left, right) => {
    const order = left.generation.writtenAt.localeCompare(
      right.generation.writtenAt,
    );
    return order !== 0 ? order : left.path.path.localeCompare(right.path.path);
  });
  const excess = sorted.length - COMPUTER_SCREENSHOT_RETENTION;
  if (excess <= 0) return;
  await step("prune", async () => {
    for (const entry of sorted.slice(0, excess)) {
      const removed = await input.workspace.delete({
        path: entry.path,
        writer: input.writer,
        expectedGenerationId: entry.generation.generationId,
      });
      if (removed.status !== "ok") return;
    }
  });
}

type ComputerCaptureStepTimerV1 = <T>(
  step: Exclude<keyof ComputerCaptureTimingV1, "total">,
  run: () => Promise<T>,
) => Promise<T>;

/** Whole milliseconds since `started`, never negative. */
export function elapsedMsV1(now: () => number, started: number): number {
  return Math.max(0, Math.round(now() - started));
}

/**
 * Runs `run` and hands its duration to `record` whether it settled or threw,
 * so a step that failed part-way still says how long it took.
 */
export async function timeComputerStepV1<T>(
  now: () => number,
  run: () => Promise<T>,
  record: (ms: number) => void,
): Promise<T> {
  const started = now();
  try {
    return await run();
  } finally {
    record(elapsedMsV1(now, started));
  }
}

/** Records into `timing` how long each step of one filing took, as it runs. */
function captureStepTimerV1(
  timing: ComputerCaptureTimingV1 | undefined,
  now: () => number,
): ComputerCaptureStepTimerV1 {
  return (step, run) =>
    timing
      ? timeComputerStepV1(now, run, (ms) => {
          timing[step] = ms;
        })
      : run();
}

/** One capture of the Bot's own desktop, refused where there is no screen. */
function captureDesktopV1(
  computer: ComputerHostSessionV1,
  input: { effectId: string; signal?: AbortSignal },
  step: ComputerCaptureStepTimerV1,
): Promise<ComputerScreenshotV1> {
  const screenshot = computer.screenshot;
  if (!screenshot) {
    throw new ComputerError(
      "capability-unavailable",
      "The selected Computer does not support screenshots",
    );
  }
  return step("screenshot", () =>
    screenshot.capture({
      effectId: input.effectId,
      ...(input.signal ? { signal: input.signal } : {}),
    }),
  );
}

/**
 * Captures the desktop and files it as a durable Workspace file: what
 * `computer_screenshot` does, because the Bot asked to see its screen and the
 * picture is part of what it did. Retention is the Turn end's, never the
 * call's: see `pruneComputerScreenshotsV1`.
 */
export async function fileComputerScreenshotV1(input: {
  computer: ComputerHostSessionV1;
  workspace: WorkspaceFilesV1;
  path: WorkspacePathV1;
  writer: WorkspaceWriterV1;
  effectId: string;
  signal?: AbortSignal;
  /** Filled with each step's duration as it runs; `total` is the caller's. */
  timing?: ComputerCaptureTimingV1;
  now?: () => number;
}): Promise<FiledComputerScreenshotV1> {
  const step = captureStepTimerV1(input.timing, input.now ?? Date.now);
  const captured = await captureDesktopV1(input.computer, input, step);
  const written = await step("write", () =>
    input.workspace.write({
      path: input.path,
      bytes: captured.bytes,
      writer: input.writer,
      expectedGenerationId: null,
      mediaType: captured.mediaType,
    }),
  );
  if (written.status !== "ok") {
    throw new Error(
      `The screenshot could not be filed: ${written.status}: ${written.reason}`,
    );
  }
  return { captured, path: input.path, generation: written.generation };
}

/**
 * Captures the desktop into the Bot's one frame: the picture the card shows
 * when it is not streaming. One capture and one Durable Object write — nothing
 * listed, versioned, synced or pruned. Answers the frame it kept, or undefined
 * when the capture was too large to keep and the previous frame stays.
 */
export async function captureComputerFrameV1(input: {
  computer: ComputerHostSessionV1;
  frames: ComputerFrameSinkV1;
  effectId: string;
  signal?: AbortSignal;
  timing?: ComputerCaptureTimingV1;
  now?: () => number;
}): Promise<StoredComputerFrameV1 | undefined> {
  const step = captureStepTimerV1(input.timing, input.now ?? Date.now);
  const captured = await captureDesktopV1(input.computer, input, step);
  const frame = await computerFrameFromCaptureV1(captured);
  if (!frame) return undefined;
  await step("write", () => input.frames.put(frame));
  return frame;
}
