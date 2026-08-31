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
  connect(): Promise<void>;
  takeControl(): Promise<void>;
  releaseControl(): Promise<void>;
  retry(): Promise<void>;
}

export const computerKey: InjectionKey<Ref<ComputerState>> =
  Symbol("computer-data");
