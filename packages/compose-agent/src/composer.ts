import { createPlugin } from "@frockbot/compose-core";
import {
  composerPrompt,
  createComposerTools,
  jsonSchemaValidator,
} from "@frockbot/compose-tools";
import { modelKey, promptKey, toolsKey } from "./keys";
import { createTool } from "./tools";
import type {
  AnyPlugin,
  AnyStubGrant,
  StandardSchemaIssue,
  StandardSchemaV1,
} from "@frockbot/compose-core";
import type { ModelRegistry } from "./types";

/** Policy captured by the example-local adapter around Compose's tool surface. */
export interface ComposerPluginOptions {
  catalog?: Readonly<Record<string, AnyPlugin>>;
  protected?: ReadonlyArray<string>;
  stubs?: ReadonlyArray<AnyStubGrant>;
  host?: string;
}

const selectModelTool = (models: ModelRegistry) =>
  createTool({
    name: "select_model",
    description: "Select the registered model provider used by the next turn.",
    parameters: {
      type: "object",
      properties: { name: { type: "string" } },
    },
    validator: jsonSchemaValidator<{ name?: string }>({
      type: "object",
      properties: { name: { type: "string" } },
      additionalProperties: false,
    }),
    concurrency: "exclusive",
    execute: ({ name }) => {
      const providers = models.list().map((provider) => provider.name);
      if (name !== undefined && !providers.includes(name)) {
        return {
          ok: false,
          error: `there is no model provider named "${name}"`,
          providers,
        };
      }
      models.select(name);
      return {
        ok: true,
        providers,
        selected: models.current()?.name,
        effect: "The selection takes effect next turn; nothing restarts.",
      };
    },
  });

/**
 * Mount `@frockbot/compose-tools` definitions in this example's tool and prompt
 * registries. The adapter is example code; the definitions remain independent
 * of this loop.
 */
export const createComposerPlugin = (policy: ComposerPluginOptions) =>
  createPlugin({
    name: "composer",
    deps: [toolsKey, promptKey, modelKey],
    setup(instance) {
      const registry = instance.context.get(toolsKey);
      for (const tool of createComposerTools({
        client: instance.client,
        ...policy,
      })) {
        instance.cleanup(
          registry.register(
            createTool({
              name: tool.name,
              description: tool.description,
              validator: tool.validator,
              parameters: tool.parameters,
              concurrency: tool.concurrency,
              execute: tool.execute,
            }),
          ),
          `tool(${tool.name})`,
        );
      }
      const selection = selectModelTool(instance.context.get(modelKey));
      instance.cleanup(registry.register(selection), `tool(${selection.name})`);
      instance.cleanup(
        instance.context.get(promptKey).register({
          name: "composer",
          order: 10,
          text: () => composerPrompt(policy),
        }),
        "prompt(composer)",
      );
    },
  });

const policyOptions: StandardSchemaV1<
  ComposerPluginOptions | undefined,
  ComposerPluginOptions
> = {
  "~standard": {
    version: 1,
    vendor: "frockbot-compose-agent",
    validate(value: unknown) {
      const input = (value ?? {}) as {
        catalog?: unknown;
        protected?: unknown;
        stubs?: unknown;
        host?: unknown;
      };
      const issues: Array<StandardSchemaIssue> = [];
      const catalog: Record<string, AnyPlugin> = {};
      if (
        input.catalog !== undefined &&
        (typeof input.catalog !== "object" || input.catalog === null)
      ) {
        issues.push({
          message: "expected an object of plugins by name",
          path: ["catalog"],
        });
      } else {
        for (const [name, plugin] of Object.entries(input.catalog ?? {})) {
          if (
            (plugin as { type?: unknown } | null)?.type !== "compose/plugin"
          ) {
            issues.push({
              message: "expected a plugin created by createPlugin",
              path: ["catalog", name],
            });
          } else catalog[name] = plugin;
        }
      }
      if (input.protected !== undefined && !Array.isArray(input.protected)) {
        issues.push({ message: "expected an array", path: ["protected"] });
      }
      const protectedValues = Array.isArray(input.protected)
        ? [...input.protected]
        : [];
      protectedValues.forEach((id, index) => {
        if (typeof id !== "string" || id === "") {
          issues.push({
            message: "expected a non-empty entry id",
            path: ["protected", index],
          });
        }
      });
      const protectedIds = protectedValues.filter(
        (id): id is string => typeof id === "string" && id !== "",
      );
      if (input.stubs !== undefined && !Array.isArray(input.stubs)) {
        issues.push({ message: "expected an array", path: ["stubs"] });
      }
      const stubValues = Array.isArray(input.stubs) ? [...input.stubs] : [];
      stubValues.forEach((stub, index) => {
        if ((stub as { type?: unknown } | null)?.type !== "compose/stub") {
          issues.push({
            message: "expected a stub grant created by createStub",
            path: ["stubs", index],
          });
        }
      });
      const stubs = stubValues.filter(
        (stub): stub is AnyStubGrant =>
          (stub as { type?: unknown } | null)?.type === "compose/stub",
      );
      if (input.host !== undefined && typeof input.host !== "string") {
        issues.push({ message: "expected a host name", path: ["host"] });
      }
      if (issues.length > 0) return { issues };
      return {
        value: {
          catalog,
          protected: protectedIds,
          stubs,
          ...(typeof input.host === "string" ? { host: input.host } : {}),
        },
      };
    },
  },
};

/** Browser-demo compatibility wrapper; deployed code uses the factory. */
export const composerPlugin = createPlugin({
  name: "composer",
  deps: [toolsKey, promptKey, modelKey],
  validator: policyOptions,
  setup(instance, policy) {
    const registry = instance.context.get(toolsKey);
    for (const tool of createComposerTools({
      client: instance.client,
      ...policy,
      protected: [...(policy.protected ?? []), "composer"],
    })) {
      instance.cleanup(
        registry.register(
          createTool({
            name: tool.name,
            description: tool.description,
            validator: tool.validator,
            parameters: tool.parameters,
            concurrency: tool.concurrency,
            execute: tool.execute,
          }),
        ),
        `tool(${tool.name})`,
      );
    }
    const selection = selectModelTool(instance.context.get(modelKey));
    instance.cleanup(registry.register(selection), `tool(${selection.name})`);
    instance.cleanup(
      instance.context.get(promptKey).register({
        name: "composer",
        order: 10,
        text: () => composerPrompt(policy),
      }),
      "prompt(composer)",
    );
  },
});
