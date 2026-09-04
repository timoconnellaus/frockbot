import type { InjectionKey, Ref } from "vue";
import type { UsageReportV1 } from "../shared.js";
import type { BillingViewV1 } from "../billing.js";

export interface UsageClientStateV1 {
  report?: UsageReportV1;
  billing?: BillingViewV1;
  loaded: boolean;
  busy: boolean;
  error?: string;
  load(): Promise<void>;
  subscribe(): Promise<void>;
  buyCredits(amountCents: number): Promise<void>;
  manageSubscription(): Promise<void>;
}

export const usageStateKey: InjectionKey<Ref<UsageClientStateV1>> =
  Symbol("usage-state");
