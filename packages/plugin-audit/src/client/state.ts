import type { InjectionKey, Ref } from "vue";
import type {
  AuditEntryV1,
  AuditIndexStateV1,
  AuditKindV1,
  AuditRebuildReceiptV1,
} from "../shared.js";

/** The filters the Activity section can apply, as the chips set them. */
export interface AuditFiltersV1 {
  kind?: AuditKindV1;
  target?: string;
}

export interface AuditClientState {
  /** The Bot the loaded rows belong to; nothing is shown for another. */
  botId?: string;
  entries: AuditEntryV1[];
  total: number;
  nextCursor?: string;
  indexState: AuditIndexStateV1;
  filters: AuditFiltersV1;
  loaded: boolean;
  busy: boolean;
  error?: string;
  /** The receipt of the most recent rebuild, held until the next load. */
  receipt?: AuditRebuildReceiptV1;
  load(botId: string, filters?: AuditFiltersV1): Promise<void>;
  loadMore(botId: string): Promise<void>;
  rebuild(botId: string): Promise<void>;
  dismissReceipt(): void;
}

export const auditStateKey: InjectionKey<Ref<AuditClientState>> =
  Symbol("audit-state");
