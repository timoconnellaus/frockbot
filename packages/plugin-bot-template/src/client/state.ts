import type { InjectionKey, Ref } from "vue";
import type {
  TemplateShareRecordV1,
  TemplateVisibilityV1,
} from "@frockbot/template-core";
import type { TemplateExportSummaryV1 } from "../shared.js";

export interface BotTemplateClientState {
  /** Every share this User holds; the section filters to the active Bot. */
  shares: TemplateShareRecordV1[];
  /** The summary of the most recent export, for the confirmation dialog. */
  summary?: TemplateExportSummaryV1;
  /** The share the dialog is open on, if any. */
  openShareId?: string;
  loaded: boolean;
  busy: boolean;
  error?: string;
  load(): Promise<void>;
  stage(botId: string): Promise<void>;
  setVisibility(
    shareId: string,
    visibility: TemplateVisibilityV1,
  ): Promise<void>;
  revoke(shareId: string): Promise<void>;
}

export const botTemplateStateKey: InjectionKey<Ref<BotTemplateClientState>> =
  Symbol("bot-template-state");
