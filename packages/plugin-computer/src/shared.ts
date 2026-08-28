import type { InjectionKey, Ref } from "vue";

export type ComputerPhase =
  | "unconfigured"
  | "idle"
  | "provisioning"
  | "ready"
  | "taking-control"
  | "human-control"
  | "error";

/** Provider-neutral state published by the selected Computer adapter. */
export interface ComputerState {
  phase: ComputerPhase;
  botId: string;
  providerLabel: string;
  message: string;
  viewerUrl?: string;
  takingControl: boolean;
  connect(): Promise<void>;
  takeControl(): Promise<void>;
  releaseControl(): Promise<void>;
  retry(): Promise<void>;
}

export const computerKey: InjectionKey<Ref<ComputerState>> =
  Symbol("computer-data");
