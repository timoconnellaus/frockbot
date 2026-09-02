import type {
  ComputerDoctorViewV1,
  ComputerPhase,
  ComputerProjectionV1,
  ComputerScreenshotViewV1,
} from "../protocol.js";

export interface ComputerMachineState {
  phase: ComputerPhase;
  botId: string;
  providerLabel: string;
  message: string;
  viewerUrl?: string;
  expanded: boolean;
  takingControl: boolean;
  screenshots: ComputerScreenshotViewV1[];
  doctor?: ComputerDoctorViewV1;
}

export type ComputerMachineEvent =
  | {
      type: "configured";
      botId: string;
      providerLabel: string;
      configured: boolean;
      message: string;
    }
  | { type: "connect-requested" }
  | { type: "connected"; viewerUrl: string }
  | { type: "take-control-requested" }
  | { type: "control-acquired" }
  | { type: "control-released" }
  | { type: "viewer-expanded" }
  | { type: "viewer-collapsed" }
  | { type: "viewer-disconnected"; message: string }
  | { type: "retry-requested" }
  | { type: "failed"; message: string; takingControl?: boolean }
  | { type: "doctor-updated"; doctor: ComputerDoctorViewV1 }
  | { type: "projection-received"; projection: ComputerProjectionV1 };

export function initialComputerMachineState(): ComputerMachineState {
  return {
    phase: "unconfigured",
    botId: "unconfigured",
    providerLabel: "unconfigured",
    message: "No Computer provider is configured for this host",
    viewerUrl: undefined,
    expanded: false,
    takingControl: false,
    screenshots: [],
    doctor: undefined,
  };
}

/**
 * The single phase transition table shared by local and hosted Computers.
 * The client only projects authority and transient request progress; it never
 * invents a durable lease or decides whether a Computer is actually awake.
 */
export function transitionComputerState(
  state: ComputerMachineState,
  event: ComputerMachineEvent,
): ComputerMachineState {
  switch (event.type) {
    case "configured":
      return {
        ...state,
        phase: event.configured ? "idle" : "unconfigured",
        botId: event.botId,
        providerLabel: event.providerLabel,
        message: event.message,
        viewerUrl: undefined,
        takingControl: false,
      };
    case "connect-requested":
    case "retry-requested":
      return {
        ...state,
        phase: "provisioning",
        message: "Waking and preparing the Computer…",
        viewerUrl: undefined,
        takingControl: false,
      };
    case "connected":
      return {
        ...state,
        phase: "ready",
        message: "Computer ready",
        viewerUrl: event.viewerUrl,
        takingControl: false,
      };
    case "take-control-requested":
      return {
        ...state,
        phase: "taking-control",
        message: "Pausing new agent computer actions…",
      };
    case "control-acquired":
      return {
        ...state,
        phase: "human-control",
        message: "You have control. Release when finished with private data.",
        takingControl: true,
      };
    case "control-released":
      return {
        ...state,
        phase: "ready",
        message: "Computer ready",
        takingControl: false,
      };
    case "viewer-expanded":
      return { ...state, expanded: true };
    case "viewer-collapsed":
      return { ...state, expanded: false };
    case "viewer-disconnected":
      return {
        ...state,
        phase: "disconnected",
        message: event.message,
        viewerUrl: undefined,
      };
    case "failed":
      return {
        ...state,
        phase: "error",
        message: event.message,
        takingControl: event.takingControl ?? state.takingControl,
      };
    case "doctor-updated":
      return { ...state, doctor: event.doctor };
    case "projection-received": {
      const projection = event.projection;
      // A Workspace read URL may be reissued on every projection, but the
      // durable bytes have not changed until their content hash does. Holding
      // the object stable keeps Vue from replacing the visible capture merely
      // because a wake-free poll returned another DTO instance (P1).
      const currentCapture = state.screenshots[0];
      const projectedCapture = projection.screenshots[0];
      const screenshots =
        currentCapture &&
        projectedCapture?.contentHash === currentCapture.contentHash
          ? [currentCapture, ...projection.screenshots.slice(1)]
          : projection.screenshots;
      return {
        phase: projection.phase,
        botId: projection.botId,
        providerLabel: projection.providerLabel,
        message: projection.message,
        viewerUrl:
          projection.phase === "disconnected"
            ? undefined
            : projection.viewerSession?.url,
        expanded: state.expanded,
        // A dead viewer and a live control lease can coexist. Keep projecting
        // the lease so Close/Escape can release it explicitly instead of
        // falling back to expiry merely because the frame disappeared (P2).
        takingControl: projection.controlLease !== undefined,
        screenshots,
        doctor: projection.doctor,
      };
    }
  }
}
