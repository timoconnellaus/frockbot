import type { InjectionKey, Ref } from "vue";

export type FlySpriteComputerPhase =
  | "missing-token"
  | "idle"
  | "provisioning"
  | "ready"
  | "taking-control"
  | "human-control"
  | "error";

export interface FlySpriteComputerState {
  phase: FlySpriteComputerPhase;
  spriteName: string;
  message: string;
  viewerUrl?: string;
  takingControl: boolean;
  connect(): Promise<void>;
  takeControl(): Promise<void>;
  releaseControl(): Promise<void>;
  retry(): Promise<void>;
}

export const flySpriteComputerKey: InjectionKey<Ref<FlySpriteComputerState>> =
  Symbol("fly-sprite-computer-data");
