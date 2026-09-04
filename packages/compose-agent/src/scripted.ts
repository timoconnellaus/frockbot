import { createPlugin } from "@frockbot/compose-core";
import { optionsSchema } from "@frockbot/compose-tools";
import { modelKey } from "./keys";
import type { ModelChunk, ModelProvider, ModelRequest } from "./types";

/** One scripted response: what the model provider streams for one request. */
export interface ScriptedResponse {
  /** Text pieces streamed in order; each becomes one `chunk` entry. */
  chunks?: ReadonlyArray<string>;
  /** Tool calls yielded after the text. Ids default to `call-1`, `call-2`, … */
  toolCalls?: ReadonlyArray<{ id?: string; name: string; args: unknown }>;
  /** Fail the stream after the chunks — a mid-stream failure (E3). */
  error?: string;
}

const scriptedOptions = optionsSchema<
  { name?: string; script: ReadonlyArray<ScriptedResponse> },
  { name: string; script: Array<ScriptedResponse> }
>((value) => ({ name: value.name ?? "scripted", script: [...value.script] }));

/**
 * A **model provider** that replays a written script, so a whole conversation
 * runs with no network and no credentials (A3, E3). It registers into the model
 * registry and unregisters through its cleanup, like any other provider (E2).
 * Responses are consumed in order, one per request; running past the end throws,
 * which the loop records as a model error rather than quietly repeating the
 * last response.
 *
 * @example
 * ```ts
 * {
 *   id: 'model',
 *   plugin: scriptedModelPlugin,
 *   options: {
 *     script: [
 *       { chunks: ['Look', 'ing…'], toolCalls: [{ name: 'search', args: { query: 'cats' } }] },
 *       { chunks: ['Found three.'] },
 *     ],
 *   },
 * }
 * ```
 */
export const scriptedModelPlugin = createPlugin({
  name: "scripted-model",
  deps: [modelKey],
  validator: scriptedOptions,
  setup(instance, options) {
    let index = 0;
    let calls = 0;

    const provider: ModelProvider = {
      name: options.name,
      stream: (_request: ModelRequest, signal: AbortSignal) => {
        const response = options.script[index];
        index += 1;
        return (async function* stream(): AsyncGenerator<ModelChunk> {
          if (!response) {
            throw new Error(
              `agent example: the scripted model has no response for request ${index}`,
            );
          }
          for (const text of response.chunks ?? []) {
            // Hand control back between chunks, as a real stream does, so a
            // cancellation lands between them rather than only at the end.
            await Promise.resolve();
            if (signal.aborted) return;
            yield { kind: "text", text };
          }
          if (response.error !== undefined) throw new Error(response.error);
          for (const call of response.toolCalls ?? []) {
            calls += 1;
            yield {
              kind: "tool-call",
              call: {
                id: call.id ?? `call-${calls}`,
                name: call.name,
                args: call.args,
              },
            };
          }
        })();
      },
    };

    instance.cleanup(
      instance.context.get(modelKey).register(provider),
      `provider(${options.name})`,
    );
  },
});

/** A scripted provider captured in a plugin factory for environment-owned catalogs. */
export const createScriptedModelPlugin = (
  script: ReadonlyArray<ScriptedResponse>,
  name = "scripted",
) =>
  createPlugin({
    name: "scripted-model",
    deps: [modelKey],
    setup(instance) {
      let index = 0;
      let calls = 0;
      const provider: ModelProvider = {
        name,
        stream: (_request: ModelRequest, signal: AbortSignal) => {
          const response = script[index];
          index += 1;
          return (async function* stream(): AsyncGenerator<ModelChunk> {
            if (!response) {
              throw new Error(
                `agent example: the scripted model has no response for request ${index}`,
              );
            }
            for (const text of response.chunks ?? []) {
              await Promise.resolve();
              if (signal.aborted) return;
              yield { kind: "text", text };
            }
            if (response.error !== undefined) throw new Error(response.error);
            for (const call of response.toolCalls ?? []) {
              calls += 1;
              yield {
                kind: "tool-call",
                call: {
                  id: call.id ?? `call-${calls}`,
                  name: call.name,
                  args: call.args,
                },
              };
            }
          })();
        },
      };
      instance.cleanup(
        instance.context.get(modelKey).register(provider),
        `provider(${name})`,
      );
    },
  });
