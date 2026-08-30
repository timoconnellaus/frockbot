import type { InjectionKey, Ref } from "vue";
// Shell selection is injected through its public hosted-client interface.
import type { FrockBotWebData } from "@frockbot/plugin-shell/shared";
import type {
  BotDirectoryViewV1,
  SheepIdentityViewV1,
  SheepRecipeV1,
} from "../shared.js";

export interface FlockWebData {
  directory: BotDirectoryViewV1;
  identities: Record<string, SheepIdentityViewV1>;
  loading: boolean;
  error?: string;
  overlay?: "create" | "edit";
  draftName: string;
  draftSheep: SheepRecipeV1;
  bindShell(shell: Ref<FrockBotWebData>): void;
  load(): Promise<void>;
  select(botId: string): Promise<void>;
  openCreate(): void;
  openEdit(): Promise<void>;
  closeOverlay(): void;
  reroll(): void;
  create(): Promise<void>;
  saveSheep(): Promise<void>;
}

export const flockWebDataKey: InjectionKey<Ref<FlockWebData>> =
  Symbol("flock-web-data");
