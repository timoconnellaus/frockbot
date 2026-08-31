// Importing the augmented module is what merges these declarations into cordis.
import type {} from "cordis";
export interface PromptAssemblyContext {
  sessionId: string;
  provider: string;
  model: string;
}

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
