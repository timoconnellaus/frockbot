import type { ComputerState } from "../shared.js";

export const COMPUTER_VIEWER_FRAME_STATES = [
  "connecting",
  "connected",
  "reconnecting",
  "error",
] as const;

export type ComputerViewerFrameStateV1 =
  (typeof COMPUTER_VIEWER_FRAME_STATES)[number];

export interface ComputerViewerFrameMessageV1 {
  type: "frockbot-viewer";
  state: ComputerViewerFrameStateV1;
  message: string;
}

/** Decodes the secret-free status message emitted by the framed viewer. */
export function decodeComputerViewerFrameMessageV1(
  value: unknown,
): ComputerViewerFrameMessageV1 | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).some(
      (key) => key !== "type" && key !== "state" && key !== "message",
    ) ||
    candidate.type !== "frockbot-viewer" ||
    !COMPUTER_VIEWER_FRAME_STATES.some((state) => state === candidate.state) ||
    typeof candidate.message !== "string" ||
    !candidate.message ||
    candidate.message.length > 200
  ) {
    return undefined;
  }
  return {
    type: "frockbot-viewer",
    state: candidate.state as ComputerViewerFrameStateV1,
    message: candidate.message,
  };
}

/**
 * Changes only noVNC's client-visible input fence on one minted session.
 *
 * The bearer token and path stay byte-for-byte inside the same URL fragment;
 * control changes no server session and mints no second secret (P2).
 */
export function viewerUrlForControlV1(
  viewerUrl: string,
  takingControl: boolean,
): string {
  const url = new URL(viewerUrl);
  const fragment = new URLSearchParams(url.hash.slice(1));
  fragment.set("view_only", takingControl ? "0" : "1");
  url.hash = fragment.toString();
  return url.toString();
}

export interface ComputerViewerActions {
  requestTakeControl(): void;
  cancelTakeControl(): void;
  confirmTakeControl(): Promise<void>;
  closeViewer(): Promise<void>;
  escape(): Promise<void>;
}

/**
 * The overlay's command boundary, separate from presentation for one reason:
 * a Take-control click opens local confirmation and cannot reach the Bot DO
 * until the second, confirmed action. Close and Escape both use the provider's
 * one close path, which releases control before collapsing the viewer (P2).
 */
export function createComputerViewerActions(
  state: () => ComputerState,
  setConfirming: (open: boolean) => void,
): ComputerViewerActions {
  return {
    requestTakeControl() {
      setConfirming(true);
    },
    cancelTakeControl() {
      setConfirming(false);
    },
    async confirmTakeControl() {
      setConfirming(false);
      await state().takeControl();
    },
    async closeViewer() {
      setConfirming(false);
      await state().closeViewer();
    },
    async escape() {
      setConfirming(false);
      await state().closeViewer();
    },
  };
}
