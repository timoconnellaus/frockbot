import type { InjectionKey, Ref } from "vue";
// Shell selection is injected through its public hosted-client interface.
import type { FrockBotWebData } from "@frockbot/plugin-shell/shared";
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
  loading: boolean;
  error?: string;
  overlay?: "create" | "edit" | "archive";
  lifecycles: Record<string, BotLifecycleStatusV1>;
  showArchived: boolean;
  lifecyclePending?: string;
  draftName: string;
  draftSheep: SheepRecipeV1;
  bindShell(shell: Ref<FrockBotWebData>): void;
  load(): Promise<void>;
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
