# Profile and account settings

Profile groups personal details, Bot abilities, and activity/sharing. Site
administration is visible only to administrators; Refresh is a page action,
not an account destination. Personal details reads the same resolved name as
the Profile header. The optional contact email does not change sign-in. The
Profile timezone is the single account clock: every scheduled Routine owned by
the User is evaluated in that IANA timezone, so the Routines surface does not
ask for one independently. It is chosen from the runtime's IANA timezone list rather
than typed, defaults to UTC, and keeps a saved selection the running catalog
does not name.

Models owns the account default and provider accounts. Automatic is the
recommended zero-setup choice. Connecting or managing a provider opens its
account page inside the app. API keys remain write-only. Custom server
addresses and provider-specific settings are collapsed under Advanced.
Image generation is a separate Models destination with readable model names.

The Marketplace is the services a Bot can be given: models and connected
apps in one searchable catalog. Adding a model provider opens its key form,
and once a key is connected its card offers Choose a model. Checkboxes under the search box choose what
is listed. Installed is the same catalog limited to what the account has
already added, where a model is configured or removed and a connected app is
managed. It is not a Profile entry: its door is on the
Bot list itself, beside the avatar on a phone and a named row at the foot of
the sidebar on a desktop. A phone opens it as a page and list; a desktop opens
it as a dialog over the shell. Installation never silently chooses a model or
creates a credential.

A Bot's Plugins are Bot settings, so their door is the Plugins row in that
Bot's Settings — one level under its page, behind the gear, at every width.
The Profile has no Plugins list and no Account features: a first-party feature
is switched per Bot and is always the account's, and a model provider is added
and removed in the Marketplace. The row says what is on before it is opened:
"5 on · Web, Routines, Image, Subagents, Messages". The Bot's page is one list
of what that Bot could switch, under two headings — **Built in**, the
first-party features and what the deployment ships, and **Made by your Bots**
— with one switch per row, and the switches are that Bot's own. The locked
card Plugins run for every Bot and a Plugin whose only contribution is a model
provider runs when that model is chosen
([ADR 0032](adr/0032-plugin-model-providers.md)), so neither is listed. A
Plugin that is on may draw a section of its own on its card, below what it
does — its own status and its own controls, drawn by the app; pressing a
control runs that Plugin's tool and the page is read again. A section that
cannot be shown says so on the card in words, and the switch stays. This page
does not remove Bot-authored composition controls. Every Bot may choose its
own model in its Settings; without a choice it follows the account default
set in Models. Core identity, history, search, memory, computer
infrastructure and site administration are not plugin switches.

Activity & history starts with all Bots from Profile. A visible Bot filter
and plain activity-type labels narrow it. Each activity link carries its Bot
and run, so it works without a previously selected conversation. Unknown
outcomes remain explicit. Rebuilding retained history is an advanced action;
it never re-executes the recorded effects.

Templates starts at Use a template when no Bot is selected. Sharing offers a
Bot chooser. Add Bot also offers the template route. Import keeps its preview
and explicit apply step. Your computers distinguishes paired personal devices
from the hosted Computer and preserves per-action approval. Site
administration offers the deployment's admission mode as New accounts — Closed, Invite only or Open — and below it
lists every account with a Plugin authoring switch: Plugin authoring is off
for an account until an administrator turns it on there. An account whose setting could
not be read shows a disabled switch, says so, and offers Try again; it is
never shown as off, and the other accounts' switches stay usable.
