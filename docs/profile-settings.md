# Profile and account settings

Profile groups personal details, Bot abilities, and activity/sharing. Site
administration is visible only to administrators; Refresh is a page action,
not an account destination. Personal details reads the same resolved name as
the Profile header. The optional contact email does not change sign-in. The
Profile timezone is the single account clock: every scheduled Routine owned by
the User is evaluated in that IANA timezone, so Routine editors do not ask for
one independently. It is chosen from the runtime's IANA timezone list rather
than typed, defaults to UTC, and keeps a saved selection the running catalog
does not name.

Models owns the account default and provider accounts. Automatic is the
recommended zero-setup choice. Connecting or managing a provider opens its
account page inside the app. API keys remain write-only. Custom server
addresses and provider-specific settings are collapsed under Advanced.
Image generation is a separate Models destination with readable model names.

The Marketplace is the services a Bot can be given and the accounts already on
them — every connector, and never a model provider. It is not a Profile entry:
its door is on the Bot list itself, beside the avatar on a phone and a named
row at the foot of the sidebar on a desktop. A phone opens it as a page and a
list; a desktop opens it as a dialog over the shell, the same providers laid
out as a grid of cards, three across at full width. It links to Messages on
your Mac. What Plugins calls "Set up in Marketplace" lands here.

Plugins is the selected Bot's page: one list of what that Bot could run —
the Plugins its User installed, what the deployment seeded, and the
first-party features a User may turn off — with one switch per row, and the
switches are that Bot's own. A locked Plugin is shown without a switch, and a
feature the account has not installed says so instead of offering one. The
profile entry names the Bot it will open. With no Bot selected it falls back
to the account's list of extensions, with visible purpose and status, search,
and collapsed version/configuration/enablement controls; the current
deployment catalog seeds nothing, so that list is empty and says so rather
than presenting deployment infrastructure as installable plugins. This page
does not introduce an extension marketplace or remove Bot-authored
composition controls. Account features is the account-wide switchboard for
optional built-in features, including per-Bot model overrides, web, routines,
image generation, Mac Messages, and helper agents; an account-wide switch off
there is the precondition a Bot's switch cannot override. Its cards use
visible controls, two columns on wide screens and one column on phones or
with large text. Core identity, history, search, memory, computer
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
administration labels the actual setting as Allow new signups, and below it
lists every account with an Applets switch: Applets are off for an account
until an administrator turns them on there. An account whose setting could
not be read shows a disabled switch, says so, and offers Try again; it is
never shown as off, and the other accounts' switches stay usable.

Capability cards share the height of the tallest visible card. Each has an on/off switch in its top-right corner and a Settings button when configuration is available. Text enlargement increases the shared height instead of clipping descriptions.
