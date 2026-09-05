import { createPlugin } from "@frockbot/compose-core";
import { optionsSchema } from "@frockbot/compose-tools";
import { promptKey } from "./keys";
import type { Cleanup } from "@frockbot/compose-core";
import type { PromptRegistry, PromptSection } from "./types";

/** Build a registry. Sections sort by `order`, then by registration order. */
const createRegistry = (): PromptRegistry => {
  const sections: Array<PromptSection> = [];
  const sorted = () =>
    sections
      .map((section, index) => ({ section, index }))
      .sort(
        (left, right) =>
          (left.section.order ?? 0) - (right.section.order ?? 0) ||
          left.index - right.index,
      )
      .map((each) => each.section);

  return {
    register: (section: PromptSection): Cleanup => {
      sections.push(section);
      return () => {
        const at = sections.indexOf(section);
        if (at !== -1) sections.splice(at, 1);
      };
    },
    list: sorted,
    assemble: () =>
      sorted()
        .map((section) =>
          typeof section.text === "function" ? section.text() : section.text,
        )
        .filter((text) => text !== "")
        .join("\n\n"),
  };
};

const registryOptions = optionsSchema<
  { sections?: ReadonlyArray<PromptSection> } | undefined,
  { sections: Array<PromptSection> }
>((value) => ({ sections: [...(value?.sections ?? [])] }));

const sectionOptions = optionsSchema<
  { sections: ReadonlyArray<PromptSection> },
  { sections: Array<PromptSection> }
>((value) => ({ sections: [...value.sections] }));

/**
 * The prompt-section registry. Provides {@link promptKey}; `assemble` is called
 * once per step, so what a section contributes is always current (C3).
 */
export const promptPlugin = createPlugin({
  name: "prompt",
  provides: [promptKey],
  validator: registryOptions,
  setup(instance, options) {
    const registry = createRegistry();
    for (const section of options.sections) {
      instance.cleanup(registry.register(section), `section(${section.name})`);
    }
    instance.provide(promptKey, registry);
  },
});

/**
 * Prompt sections contributed by their own plugin entry, so adding the entry
 * makes them show up in the very next request and removing it takes them out
 * again (C3).
 *
 * @example
 * ```ts
 * await client.addPlugin({
 *   id: 'tone',
 *   plugin: promptSectionPlugin,
 *   options: { sections: [{ name: 'tone', text: 'Answer briefly.' }] },
 * })
 * ```
 */
export const promptSectionPlugin = createPlugin({
  name: "prompt-section",
  deps: [promptKey],
  validator: sectionOptions,
  setup(instance, options) {
    const registry = instance.context.get(promptKey);
    for (const section of options.sections) {
      instance.cleanup(registry.register(section), `section(${section.name})`);
    }
  },
});
