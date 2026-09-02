import type { ComputerState } from "../shared.js";

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
