import type { InjectionKey, Ref } from "vue";
// Shell selection is injected through its public hosted-client interface.
import type { FrockBotWebData } from "@frockbot/plugin-shell/shared";
import type { BotUnreadViewV1 } from "@frockbot/plugin-shell/unread";
import type {
  BotDirectoryViewV1,
  BotIdentityViewV1,
  BotLifecycleStatusV1,
  SheepIdentityViewV1,
  SheepRecipeV1,
} from "../shared.js";

export interface FlockWebData {
  directory: BotDirectoryViewV1;
  identities: Record<string, SheepIdentityViewV1>;
  /** Live Bot identity — the current name, title, avatar and hidden flag. */
  profiles: Record<string, BotIdentityViewV1>;
  /** Reveals Bots their own settings hide from the list. */
  showHidden: boolean;
  /** Per-Bot unread, as the Bot Durable Objects derive it. Never computed here. */
  unread: Record<string, BotUnreadViewV1>;
  loading: boolean;
  /**
   * Whether the Bot list has ever been read from the deployment. An empty
   * list means "no Bots" only once this is true: before it, and after a load
   * that failed, an empty list is an unknown list, and the sidebar must not
   * offer to create a first Bot for a User who already has one.
   */
  loaded: boolean;
  error?: string;
  overlay?: "create" | "edit" | "archive";
  lifecycles: Record<string, BotLifecycleStatusV1>;
  showArchived: boolean;
  lifecyclePending?: string;
  draftName: string;
  draftSheep: SheepRecipeV1;
  bindShell(shell: Ref<FrockBotWebData>): void;
  load(): Promise<void>;
  /** Re-reads the bounded unread fan-out for the whole sidebar. */
  refreshUnread(): Promise<void>;
  /** The authenticated read receipt. Never fired from a poll. */
  markRead(botId: string): Promise<void>;
  /** User intent: keep this Bot bold until it is opened again. */
  markUnread(botId: string): Promise<void>;
  select(botId: string): Promise<void>;
  openCreate(): void;
  openEdit(): Promise<void>;
  toggleArchived(): void;
  toggleHidden(): void;
  openArchive(botId: string): void;
  archive(): Promise<void>;
  restore(botId: string): Promise<void>;
  closeOverlay(): void;
  reroll(): void;
  create(): Promise<void>;
  saveSheep(): Promise<void>;
}

export const flockWebDataKey: InjectionKey<Ref<FlockWebData>> =
  Symbol("flock-web-data");
