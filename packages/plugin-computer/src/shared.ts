import type { InjectionKey, Ref } from "vue";

export type ComputerPhase =
  | "unconfigured"
  | "idle"
  | "provisioning"
  | "ready"
  | "taking-control"
  | "human-control"
  | "error";

/**
 * One capture in the Bot's durable screenshots root, as the card renders it.
 *
 * `url` addresses the Workspace read route rather than the Computer: the
 * capture is durable content in object storage, so showing it wakes nothing.
 */
export interface ComputerScreenshotViewV1 {
  path: string;
  capturedAt: string;
  contentHash: string;
  url: string;
}

/**
 * The Computer's last self-check, as the card renders it.
 *
 * The report is the Computer's own answer, decoded at the provider seam; the
 * card only draws it. A Computer that has never been asked has none, which is
 * a different thing from one whose checks all passed.
 */
export interface ComputerDoctorViewV1 {
  capturedAt: string;
  summary: string;
  checks: { name: string; status: "pass" | "fail"; detail: string }[];
}

/** Provider-neutral state published by the selected Computer adapter. */
export interface ComputerState {
  phase: ComputerPhase;
  botId: string;
  providerLabel: string;
  message: string;
  viewerUrl?: string;
  takingControl: boolean;
  /** Newest first. Empty where the host publishes no captures. */
  screenshots?: ComputerScreenshotViewV1[];
  /** The last self-check, absent until one has been run. */
  doctor?: ComputerDoctorViewV1;
  /** Absent where the host cannot run one; the card hides the button. */
  runDoctor?(): Promise<void>;
  connect(): Promise<void>;
  takeControl(): Promise<void>;
  releaseControl(): Promise<void>;
  retry(): Promise<void>;
}

export const computerKey: InjectionKey<Ref<ComputerState>> =
  Symbol("computer-data");
