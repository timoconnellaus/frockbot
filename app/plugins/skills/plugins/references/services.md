# Services

Plugins in one User's worker share a realm. A typed service is how one
Plugin offers a value another Plugin declared it needs, without opening
`ctx` to the whole worker.

In `plugin.json`:

```json
"provides": [{ "name": "notes-index", "version": 1 }],
"consumes": [{ "name": "notes-index", "version": 1 }]
```

`name` is `^[a-z][a-z0-9-]{0,63}$`. `version` is the major version; a
consumer needs the same one. At most 32 of each.

In `plugin.ts` the provider exports the values by that name:

```ts
export const services = {
  "notes-index": { version: 1, lookup: (key: string) => key },
};
```

The consumer reads `ctx.services["notes-index"]`. An unmet `consumes`
disables **that Plugin alone**; the rest of the worker still mounts.
`provides` must match `export const services` name for name at publish.

Do not put a secret in a service value. A grant one Plugin holds is
honestly described as held by all of them in this worker — that is why
open network is a card the User sees as account-wide.
