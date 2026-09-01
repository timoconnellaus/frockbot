// Importing the augmented module is what merges these declarations into cordis.
import type {} from "cordis";
import type { TurnTypeV1 } from "./types.js";

export interface PromptAssemblyContext {
  sessionId: string;
  provider: string;
  model: string;
  /**
   * The turn type this Turn was admitted as, so a section can render what the
   * Turn may actually do. A host with no Turn to speak of assembles as `chat`:
   * that is what {@link DEFAULT_PROMPT_ASSEMBLY_TURN_TYPE_V1} is for, and it
   * is a default rather than an optional field so a section never has to guess
   * what an absent turn type meant.
   */
  turnType: TurnTypeV1;
}

/** What a host assembles as when it is not running an admitted Turn. */
export const DEFAULT_PROMPT_ASSEMBLY_TURN_TYPE_V1: TurnTypeV1 = "chat";

export interface PromptSection {
  id: string;
  order?: number;
  render(context: PromptAssemblyContext): string | Promise<string>;
}

export interface PromptAssembly {
  text: string;
  sections: Array<{ id: string; text: string }>;
}

/** The kernel-declared system prompt interface. Implemented by a Package. */
export interface PromptAssemblyService {
  assemble(context: PromptAssemblyContext): Promise<PromptAssembly>;
}

/** Contributing Packages register prompt sections through this surface. */
export interface PromptSectionRegistration {
  register(section: PromptSection): () => void;
}

declare module "cordis" {
  interface Context {
    systemPrompt: PromptAssemblyService & PromptSectionRegistration;
  }

  interface Events {
    "system-prompt/assemble": (
      context: PromptAssemblyContext,
      next: () => Promise<PromptAssembly>,
    ) => Promise<PromptAssembly>;
  }
}
