import type { InjectionKey, Ref } from "vue";
import type { UsageReportV1 } from "../shared.js";

export interface UsageClientStateV1 {
  report?: UsageReportV1;
  loaded: boolean;
  busy: boolean;
  error?: string;
  load(): Promise<void>;
}

export const usageStateKey: InjectionKey<Ref<UsageClientStateV1>> =
  Symbol("usage-state");
