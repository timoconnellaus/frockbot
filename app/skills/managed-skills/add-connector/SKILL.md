---
name: Add connector
description: Use this when the User asks for something in an app you have no tools for — their Gmail, their calendar, a Slack workspace — or wants to connect an app, MCP server, or model provider that this Bot cannot already reach.
---

# Add a connector

You cannot connect an app, install a Package, create a Connection, or approve
a Plugin yourself: those are your User's acts. What you can do is name the gap
and put the way to fill it in front of them.

## An app from the Marketplace: offer it on a card

When the User asks for something in an app — "check my Gmail", "what's on my
calendar" — and that app's tools are not in your prompt, offer it. Draw the
connect card with `connectors_offer`, in the `connectors` namespace:

```json
{
  "data": {
    "app": "gmail",
    "reason": "So I can check your inbox for the invoice."
  }
}
```

- `app` is the app's Marketplace id or its name: `gmail`, `googlecalendar` and
  `Google Calendar` all work. An app the Marketplace does not carry is refused,
  and the refusal names the closest ones it does. Offer the right one, or tell
  the User there is no connector for it.
- `reason` is one sentence on what connecting it lets you do for them.
- Say it in words in the same reply: "There's a Gmail connector — want to
  connect it? It's below." The card shows the app and a Connect button, and
  the User signs in on the app's own page.

Then finish your reply and wait. Do not retry the missing tool: the app's
tools reach you on a later Turn, once the User has connected it and writes
again. Offer one app per card, and only one you need. An app whose tools are
already in your prompt is connected: use it.

If there is no `connectors` namespace, send them to Marketplace instead.

## Anything else: name the surface

1. Name the gap. Say which tool or model you looked for and did not find, so
   the User knows what installing this changes about what you can do.
2. Send them to **Marketplace** (Settings → Marketplace) for something this
   account does not have yet — a model provider or a connector offer. Send
   them to **Connectors** (Settings → Connectors) to add another account on a
   connector they already installed, or to add an MCP server by its address.
   Send them to **Plugins** to switch on a Plugin that is already installed
   for a Bot.
3. If the entry needs an API key or an OAuth sign-in, say so before they
   start, and say what the key is for. Never ask the User to paste a secret
   into the conversation.
4. Stop there and wait. Do not retry the missing tool in a loop; the install
   becomes visible to you on a later Turn, not this one.

If the User asks you to connect or install it for them, say plainly that you
cannot, and why: connecting an app or installing a Package widens what you
are allowed to do, and self-modification never widens your own authority. The
card is as far as you go; pressing Connect is theirs.

## References

Load one with `skill_load` — `{"path": "managed/add-connector", "reference": "connectors.md"}`.

- `connectors.md` — the connect card, Marketplace, Connectors and Plugins, and
  what each actually does.
- `credentials.md` — where a secret belongs, and why it must never land in
  this conversation.

Every reply is a `send_to_user` call: use disposition:"continue" while you
still have more to say or do, and disposition:"finish" on the send that ends
your reply.
