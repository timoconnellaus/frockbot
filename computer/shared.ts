import type { InjectionKey, Ref } from "vue";
import type {
  ComputerDoctorViewV1,
  ComputerPhase,
  ComputerProgressViewV1,
  ComputerScreenshotViewV1,
} from "./protocol.js";

export * from "./protocol.js";

/**
 * One capture in the Bot's durable screenshots root, as the card renders it.
 *
 * `url` addresses the Workspace read route rather than the Computer: the
 * capture is durable content in object storage, so showing it wakes nothing.
 */
export type { ComputerScreenshotViewV1 };

/**
 * The Computer's last self-check, as the card renders it.
 *
 * The report is the Computer's own answer, decoded at the provider seam; the
 * card only draws it. A Computer that has never been asked has none, which is
 * a different thing from one whose checks all passed.
 */
export type { ComputerDoctorViewV1, ComputerPhase };

/** Provider-neutral state published by the selected Computer adapter. */
export interface ComputerState {
  phase: ComputerPhase;
  botId: string;
  providerLabel: string;
  message: string;
  progress?: ComputerProgressViewV1;
  viewerUrl?: string;
  /** Whether the one live viewer is open over the hosted shell. */
  expanded: boolean;
  takingControl: boolean;
  /** Newest first. Empty where the host publishes no captures. */
  screenshots?: ComputerScreenshotViewV1[];
  /** The last self-check, absent until one has been run. */
  doctor?: ComputerDoctorViewV1;
  /** Absent where the host cannot run one; the card hides the button. */
  runDoctor?(): Promise<void>;
  connect(): Promise<void>;
  /** Explicit User open. An idle Computer may wake; rendering never does. */
  openViewer(): Promise<void>;
  /**
   * Declares that a view-only card preview is on screen.
   *
   * Held, the one minted viewer session is kept alive by the same heartbeat
   * the full-screen viewer uses, so a card watching a working Bot does not
   * lose the desktop to session expiry. Releasing it lets the session lapse,
   * which is what stops an idle Bot from holding a VNC connection. It mints
   * nothing and wakes nothing: a Computer with no session stays on the
   * stored capture (P1).
   */
  holdLivePreview?(held: boolean): void;
  /** Closes the viewer, releasing human control before it disappears. */
  closeViewer(): Promise<void>;
  takeControl(): Promise<void>;
  releaseControl(): Promise<void>;
  retry(): Promise<void>;
}

export const computerKey: InjectionKey<Ref<ComputerState>> =
  Symbol("computer-data");
