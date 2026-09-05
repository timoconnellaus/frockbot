import { createPlugin } from "@frockbot/compose-core";
import { optionsSchema } from "@frockbot/compose-tools";
import { modelKey } from "./keys";
import type { Cleanup } from "@frockbot/compose-core";
import type { ModelProvider, ModelRegistry } from "./types";

/**
 * Build a registry. The current provider is the one `select` named while it is
 * registered, and otherwise the most recently registered one — so an agent
 * assembled with a single provider never has to select anything, and a stale
 * selection falls back rather than leaving the agent with no model at all.
 */
const createRegistry = (selected: string | undefined): ModelRegistry => {
  const providers: Array<ModelProvider> = [];
  let choice = selected;
  return {
    register: (provider: ModelProvider): Cleanup => {
      providers.push(provider);
      return () => {
        const at = providers.indexOf(provider);
        if (at !== -1) providers.splice(at, 1);
      };
    },
    list: () => [...providers],
    current: () =>
      providers.find((provider) => provider.name === choice) ??
      providers[providers.length - 1],
    select: (name: string | undefined) => {
      choice = name;
    },
  };
};

const registryOptions = optionsSchema<
  { select?: string } | undefined,
  { select: string | undefined }
>((value) => ({ select: value?.select }));

/**
 * The model registry. Provides {@link modelKey} for the life of the client, so
 * a **model provider** is added, removed or selected without the loop or any
 * other plugin restarting (A2, E2).
 *
 * @example
 * ```ts
 * { id: 'models', plugin: modelsPlugin, options: { select: 'gpt-4o-mini' } }
 * ```
 */
export const modelsPlugin = createPlugin({
  name: "models",
  provides: [modelKey],
  validator: registryOptions,
  setup(instance, options) {
    instance.provide(modelKey, createRegistry(options.select));
  },
});
