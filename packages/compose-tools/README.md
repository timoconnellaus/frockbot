# `@frockbot/compose-tools`

> Vendored from `tanstack-compose` commit `69163be` on 2026-09-05. FrockBot
> keeps this copy intentionally close to upstream so it can be reviewed and
> migrated independently.

Plain composer tool definitions over a [`@frockbot/compose-core`](../compose-core)
**client**. This package does not contain an agent loop, session, prompt or
model integration; adapt the returned definitions to whichever agent runtime
you use.

```ts
import { createComposerTools } from "@frockbot/compose-tools";

const definitions = createComposerTools({
  client,
  catalog: { clock: clockPlugin },
  protected: ["policy"],
  stubs: [storageStub],
  host: "cloudflare",
});

for (const definition of definitions) {
  agentTools.register({
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    validator: definition.validator,
    execute: definition.execute,
  });
}
```

The tools list, enable, disable, configure, add from the closed catalog, read,
write, rewrite and remove entries. Source is checked against exactly the grants
it will receive. `read_plugin` is required before `rewrite_plugin`, and the
rewrite is refused if the source changed after the read.

`composerPrompt(options)` returns the live explanatory prompt section an agent
runtime may mount beside the tools. `optionsSchema`, `jsonSchemaValidator`, and
`schemaOf` are exported for runtimes and catalog plugins that need to expose
the same option metadata.
