import type { ComputerPhase } from "../protocol.js";

/**
 * How long the card keeps streaming after the Bot's Turn settles.
 *
 * A Turn that ends is usually followed by another within seconds — a tool
 * result the model answers, or a User reply. Dropping the VNC connection the
 * instant a Turn stops would make the next one reconnect from black, which is
 * the stall this feature exists to remove. The grace window is what stops an
 * idle Bot from holding a connection all afternoon.
 */
export const COMPUTER_LIVE_PREVIEW_GRACE_MS = 15_000;

/** How often the card re-reads its own status line while it is on screen. */
export const COMPUTER_SCREEN_STATUS_TICK_MS = 1_000;

/**
 * The phases in which a minted viewer session addresses a desktop that is
 * actually there. Provisioning and updating are hosts mid-operation, and the
 * card draws their progress rather than a frame that cannot connect.
 */
const STREAMABLE_PHASES: readonly ComputerPhase[] = [
  "ready",
  "taking-control",
  "human-control",
];

export type ComputerScreenModeV1 = "stream" | "snapshot";

export interface ComputerScreenModeInputV1 {
  /** The minted view-only viewer URL, absent until a session exists. */
  viewerUrl?: string;
  phase: ComputerPhase;
  /** The full-screen viewer is open over the shell. */
  expanded: boolean;
  /** A Turn is executing for the selected Bot right now. */
  turnRunning: boolean;
  /** The card is mounted and inside the viewport. */
  onScreen: boolean;
  /** `document.visibilityState === "visible"`. */
  documentVisible: boolean;
  /**
   * Milliseconds since the Bot's last Turn stopped running. Undefined where
   * no Turn has run in this session, which is not a reason to stream.
   */
  sinceTurnEndedMs?: number;
  graceMs?: number;
}

/**
 * Whether the card draws the Bot's desktop live or the last stored capture.
 *
 * The rule is one sentence: stream a desktop that exists, to a card someone
 * is actually looking at, while the Bot is working or has just stopped. Every
 * other answer is the snapshot, which costs nothing to hold.
 */
export function computerScreenModeV1(
  input: ComputerScreenModeInputV1,
): ComputerScreenModeV1 {
  if (!input.viewerUrl) return "snapshot";
  if (!input.documentVisible) return "snapshot";
  if (!input.onScreen && !input.expanded) return "snapshot";
  if (!STREAMABLE_PHASES.includes(input.phase)) return "snapshot";
  if (input.expanded || input.turnRunning) return "stream";
  const grace = input.graceMs ?? COMPUTER_LIVE_PREVIEW_GRACE_MS;
  const since = input.sinceTurnEndedMs;
  return since !== undefined && since < grace ? "stream" : "snapshot";
}

/** A whole-unit age, coarse enough that it does not redraw every frame. */
export function computerSnapshotAgeLabelV1(ageMs: number): string {
  const seconds = Math.max(0, Math.floor(ageMs / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * The one line under the screen, in the User's words.
 *
 * "Live" and "Snapshot · 12s ago" are the whole vocabulary: the User asked
 * whether they are watching the Bot or a photograph of it, and no answer that
 * names a transport or a session answers that question.
 */
export function computerScreenStatusLabelV1(input: {
  mode: ComputerScreenModeV1;
  capturedAt?: string;
  now: number;
}): string | undefined {
  if (input.mode === "stream") return "Live";
  if (!input.capturedAt) return undefined;
  const capturedAt = Date.parse(input.capturedAt);
  if (!Number.isFinite(capturedAt)) return undefined;
  return `Snapshot · ${computerSnapshotAgeLabelV1(input.now - capturedAt)}`;
}
