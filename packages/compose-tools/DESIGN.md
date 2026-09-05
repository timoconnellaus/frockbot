# `@frockbot/compose-tools` — composer tool design

This package is the part of Compose intended for an agent runtime to operate.
It implements the stance fixed by upstream ADR-0006, an extension surface on
ordinary code:
Compose owns the tool surface over a **client**, while the conversation loop,
session, prompt, registries, model providers, and credentials belong to the
application using those tools.

## Surface

`createComposerTools({ client, ...policy })` returns plain tool definitions.
Each definition is only data and a function: `name`, `description`, JSON
`parameters`, `concurrency`, and `execute(input)`. It has no dependency on an
agent SDK, a model registry, a prompt registry, React, or a host. An agent
runtime adapts those definitions to its own tool shape; the examples register
them in their example-local registry.

The definitions are, in order:

| Tool               | Effect on the client                                                          |
| ------------------ | ----------------------------------------------------------------------------- |
| `list_plugins`     | Report the current list, status, options, schemas, catalog, and declarations. |
| `enable_plugin`    | Enable one unprotected entry.                                                 |
| `disable_plugin`   | Disable one unprotected entry.                                                |
| `configure_plugin` | Replace and validate one entry's complete options.                            |
| `add_from_catalog` | Add one operator-catalogued plugin under an unused id.                        |
| `read_plugin`      | Read source and establish the optimistic rewrite gate.                        |
| `write_plugin`     | Check and add new source under an unused id.                                  |
| `rewrite_plugin`   | Check and replace source only when it is unchanged since `read_plugin`.       |
| `remove_plugin`    | Remove one unprotected entry.                                                 |

Splitting write from rewrite makes the destructive case explicit and keeps a
first write from accidentally replacing an entry. All edit tools take the one
path `client.setPluginList(next)` and wait for settlement before reporting.

## Operator policy

The caller supplies the closed **plugin catalog**, protected ids, the grants
given to written source, and an optional host name. None is changeable by a
tool call. Omitting the host keeps catalog and existing-entry tools usable but
makes source writing and rewriting fail before activation; it never selects an
in-process default. The composer's own adapter id is not special to this
package; the adapter includes it in `protected` like every other policy-owned
entry.

Catalog options and configuration are validated with each plugin's own
Standard Schema. A plugin without a validator refuses a non-empty options
object. A validator may carry a JSON schema, exposed by `schemaOf`; listings
report current options, entry `optionsSchema`, and `catalogOptions`.

## Source and declarations

Source is checked before the list changes. The check carries the client's
`baseVersion` and exactly the grants the entry will receive. `list_plugins` and
`read_plugin` show the declarations produced by that same checker, falling
back to `stubDeclarations` when the checker does not publish them.

`read_plugin` remembers the source bytes observed for an id. A rewrite is
refused until a read has occurred, and refused again if the bytes changed in
between. Successful or attempted rewrites clear the observation. This is an
in-memory editing gate, not persisted authority; after object eviction an
agent reads again before rewriting.

Written entries are ordinary single source entries. UI, storage, schedules,
and any other authority are just grants. The package has no concept of a view,
session, model, or Dynamic Worker.

## Prompt text

`composerPrompt(policy)` returns the live explanatory section an agent example
may mount in its prompt registry. It names protected ids and catalog names and
describes the tool timing. Keeping it as text returned from a function avoids
making a prompt registry part of Compose.

## Schemas

The small JSON Schema validator and `optionsSchema` move with the composer
surface because tool argument validation and option-description reporting are
part of that surface. They remain validator-library-neutral Standard Schemas.

## Verification

`tests/composer.test.ts` exercises all nine definitions directly. The
example-local suite then proves that the same definitions remain ordinary agent
tools when mounted in a conversation loop.

## Criterion → test

| Criterion                       | Test file                                                             | Coverage                                                                                                                         |
| ------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Self-modification A1–A3         | `tests/composer.test.ts`                                              | All nine definitions, settled edit results, and the single plugin-list path.                                                     |
| Self-modification B1, B3–B4     | `tests/composer.test.ts`                                              | Protected ids, catalog/options validation, schemas and operator-owned grants.                                                    |
| Self-modification D3, D6–D8     | `tests/composer.test.ts`                                              | Source ownership, read-before-rewrite, exact granted stubs and checker declarations.                                             |
| Self-modification A4, C1–C4, E1 | `../compose-agent/tests/{composer,consequences,self-editing}.test.ts` | Definitions mounted in `@frockbot/compose-agent`'s loop, including middleware, turn visibility and the end-to-end edit sequence. |

Upstream's deleted `compose-agent` packaging test is intentionally not restored:
the published package whose ESM/CommonJS export shape it checked no longer
exists, and this copy is workspace-private with no build or publish step of its
own.
