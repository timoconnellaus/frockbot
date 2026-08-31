import type { PackageRevisionHistoryV1 } from "../shared.js";
import type { InjectionKey, Ref } from "vue";

export interface PackagePublisherClientState {
  history?: PackageRevisionHistoryV1;
  busy: boolean;
  error?: string;
  load(): Promise<void>;
  rollback(packageRevision: number): Promise<void>;
}

export const packagePublisherStateKey: InjectionKey<
  Ref<PackagePublisherClientState>
> = Symbol("package-publisher-state");
