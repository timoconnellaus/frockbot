import { type Context, Service } from "cordis";

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

declare module "cordis" {
  interface Context {
    systemPrompt: SystemPromptRegistry;
  }

  interface Events {
    "system-prompt/assemble": (
      context: PromptAssemblyContext,
      next: () => Promise<PromptAssembly>,
    ) => Promise<PromptAssembly>;
  }
}

export class SystemPromptRegistry extends Service {
  private sections = new Map<string, PromptSection>();

  constructor(ctx: Context) {
    super(ctx, "systemPrompt");
  }

  register(section: PromptSection): () => void {
    if (this.sections.has(section.id)) {
      throw new Error(`prompt section "${section.id}" is already registered`);
    }
    this.sections.set(section.id, section);
    return () => {
      if (this.sections.get(section.id) === section)
        this.sections.delete(section.id);
    };
  }

  assemble(context: PromptAssemblyContext): Promise<PromptAssembly> {
    return this.ctx.waterfall("system-prompt/assemble", context, async () => {
      const sections = [...this.sections.values()].sort(
        (left, right) => (left.order ?? 0) - (right.order ?? 0),
      );
      const rendered = await Promise.all(
        sections.map(async (section) => ({
          id: section.id,
          text: await section.render(context),
        })),
      );
      return {
        sections: rendered,
        text: rendered
          .map((section) => section.text.trim())
          .filter(Boolean)
          .join("\n\n"),
      };
    });
  }
}
