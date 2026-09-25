# Triggers

A Plugin can receive deliveries from outside — a webhook from another
service — and decide what a Routine runs on. Export `triggers`, one function
per trigger name, and declare each one's name and description in
`plugin.json`:

```ts
import type { PluginTriggers } from "@frockbot/applet-sdk/plugin";

export const triggers: PluginTriggers = {
  alert: async (delivery, ctx) => {
    const event = JSON.parse(delivery.body);
    if (event.severity !== "severe") return { drop: true, reason: "minor" };
    return `Severe weather alert for ${event.city}: ${event.headline}`;
  },
};
```

`delivery` is `{ headers, body }`, headers lower-cased and without the door's
own credential. When the Plugin's own device module emitted the event,
`delivery.source` is `{ kind: "device-module", moduleId, machineId, key }`,
the body is the payload as JSON text, and there are no headers. Return a string and a Routine fires with that text as its
delivered payload; return `{ drop: true, reason }` (or nothing) and it does
not. Then create the Routine with `routine_manage`:

```json
{
  "action": "create",
  "name": "Weather alerts",
  "prompt": "Tell the User what the alert means.",
  "pluginTrigger": { "pluginId": "weather", "trigger": "alert" }
}
```

The Routine is keyed like a webhook one — the receipt carries the URL and the
key the outside service posts to — and the Plugin must be on for this Bot,
or every delivery is dropped with that reason.
