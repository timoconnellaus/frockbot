# ADR 0035: The device bridge

Status: proposed, 2026-09-24. Numbered after ADR 0034; nothing on `main` or in
an open pull request holds 0035. Decisions are Tim's from the 2026-09-24
discussion: the scenarios below, device abilities approved once per account,
shell commands decided by Jev, and the Bot list staying trust chrome. The
shapes below are the proposal that discussion asked for.

## Context

The marketing site names a **device bridge**: "The same Bot on every client.
Triggers come in, surfaces go out, and native reach stays with the host." The
architecture diagram gives it two directions: into the Bot, entries and device
triggers; back to the device, actions, slots and cards, drawn by the host. No
ADR, plan or `CONTEXT.md` term described it. This one does, starting from what
a User should be able to do.

### What a User should be able to do

| #   | Scenario                                                                  | Direction     |
| --- | ------------------------------------------------------------------------- | ------------- |
| 1   | A guitar tuner in a panel hears the microphone and moves its needle live  | local         |
| 2   | Scan a receipt with the camera from a panel and hand it to the Bot        | local, in     |
| 3   | A chess board or whiteboard the person and the Bot both move on           | local         |
| 4   | A panel map that follows where the phone is                               | local         |
| 5   | Arriving home fires a Routine, with the app closed                        | in (trigger)  |
| 6   | Share a page or a photo from another app into a Bot                       | in (entry)    |
| 7   | Tap an NFC tag on the desk to start a Routine                             | in (entry)    |
| 8   | The car's Bluetooth connects and the Bot reads a briefing on its speakers | in, then out  |
| 9   | Ask from the phone; the Mac opens the project                             | out (action)  |
| 10  | The Bot sets an alarm, a timer or a calendar event on the phone           | out (action)  |
| 11  | The Bot runs `git pull` or the tests in a shell on the Mac                | out (action)  |
| 12  | Approve or deny from a lock-screen notification                           | out, then in  |
| 13  | A home-screen widget shows a Plugin's data; a tap logs something          | out (surface) |
| 14  | A watch tile to glance at and log from                                    | out (surface) |
| 15  | A Mac menu bar item with the Bots' status and quick actions               | out (surface) |
| 16  | A browser extension lets the Bot read the current page and fill in a form | in and out    |

Scenarios 1–4 are a page on the device using the device where it is open; that
page is [ADR 0036](0036-plugin-html-surfaces.md). This ADR owns everything that
makes a device an endpoint of the Bot, including the device abilities a page is
allowed to reach.

### What already exists

- **Three records of one device.** A native sign-in session
  (`apps/cloudflare/src/native-sessions.ts`, `native:sessions:v1`) knows the
  client's protocol and version but not its platform or name. A push device
  (`apps/cloudflare/src/push.ts`, `push:device:<deviceId>`) has a
  client-minted `deviceId`, a push token and a 15-second presence lease. A
  registered machine (`app/machine/`, `core/machine-protocol/`) has an id, a
  label, a platform, capabilities and presence derived from polling.
- **A device command path, for Macs.** The machine protocol records intent
  before anything runs (`commandId` is the Turn's effect id), queues on the User
  Durable Object, lets a machine long-poll, claims first-write-wins, re-offers
  once after a lease expiry and then marks the command `unknown`, answers a
  replayed result with `replayed`, and delivers the result to the Bot as a
  Pending input (`app/machine/delivery.ts`). An effectful op puts an approval
  card in front of the person, in chat Turns only. The protocol carries
  `exec`, `files` and `messages`. The Mac app's helper
  (`apps/mac-messages/agent.ts`) enrols through it and offers `messages` alone,
  behind a consent the app asks for.
- **Push on Android only.** FCM is wired server and client side. There is no
  iOS project, so no APNs, no web push, and nothing on macOS but the dock
  badge. The per-Bot state channel is server-push while a client is connected.
- **No inbound files.** `TurnCommand` is text and Skills. Nothing uploads from
  a client; `attachment` sends run from the Bot to the person.
- **Deep links** through `app_links` for sign-in return, Bot links and connect
  return. No share sheet, NFC, geofence, Bluetooth, widget, watch, tray or
  browser extension code exists.
- **One microphone owner** at a time (`apps/native/lib/voice/mic_ownership.dart`),
  shared by dictation and the voice assistant.

## Decision

### A Device is one installation of a client

The User Durable Object keeps one **Device** record per installation of a
FrockBot client: a phone app, a desktop app, a watch app, a browser extension,
or the web client while signed in. The record holds the client-minted
`deviceId`, platform and kind, an editable label, the client version, the
device abilities the build reports, the operating system's permission state as
last reported, the push token, and presence.

The push device record and the machine record become this one record, and a
native sign-in session names the Device it belongs to. A desktop's device
agent enrols through its own signed-in app rather than a pairing code typed
into a browser; the machine token becomes the Device's command credential.
Revoking a Device ends its session, its token and its push registration
together.

A Device is the User's, and every Bot of that User can reach it. That is
account-shaped configuration, not a per-Bot choice. The Bot lists Devices with
the tool that lists machines today.

### Device abilities are host code

What a Device can do is a catalog compiled into the kernel and the client.
Each **device ability** has a name, an input schema, an effect (`read` or
`mutate`, classified only by this trusted catalog, as the Jev plan requires)
and a tier:

- **Local:** used by a page on the Device where it is open, while it is on
  screen: `microphone`, `camera`, `location`. Nothing leaves the Device unless
  the page sends it ([ADR 0036](0036-plugin-html-surfaces.md)).
- **Ordinary:** a command a Device runs for the Bot: `notification.show`,
  `audio.play`, `url.open`, `app.open`, `alarm.set`, `timer.set`,
  `calendar.write`, `reminders.write`.
- **Own machine:** reach into the person's own computer and accounts:
  `shell.exec`, `files.read`, `files.write`, `messages.send`,
  `browser.page.read`, `browser.page.fill`. These are first-party tools only.
  A Plugin cannot hold one, because Jev reviews the tool call the model makes.
  A Plugin tool that ran a shell command inside itself would put the command
  where review never sees it.

A Device reports which abilities its build carries and whether the OS has
granted each. The kernel never queues a command a Device cannot run. It tells
the Bot so, in words the Bot can repeat. A new ability is a client release and
an amendment to the catalog, never a Plugin. Plugins get only abilities the
host already has.

### Two layers of consent

1. **The Plugin's card, once per account.** A Plugin declares
   `device: { abilities: [...] }` beside `network`, and `device` joins the
   grants. An ability is approved where declared hosts are approved: on the
   approval card at publish and enable, and on the Plugins page. The approval
   covers every Device of the account. There is no per-Device list. A
   descriptor naming an own-machine ability is refused at resolve.
2. **The Device, once per device.** The operating system asks on first use,
   as it does for the microphone, camera, location, calendar and notifications.
   Where the OS has no prompt of its own (shell, files, Messages), the client
   asks once in its own chrome, as Messages sharing already does. Turning it off
   again is a setting on that Device, and the Device reports it.

The Bot's own first-party device tools are app code and need no Plugin
approval. The Device's consent gates them, and so does review of their
mutations.

### Out: device commands ride the machine protocol

The machine command path becomes the device command path. Intent is recorded
before the send, the command is keyed by the effect id, queued on the User
Durable Object, claimed first-write-wins, and its result reaches the Bot as a
Pending input that opens the next Turn. A Turn does not stay resident waiting
for a Device. Five things change:

- **A command names its Device.** The Bot chooses from the Device list. A
  command raised by a device trigger may instead name `origin`, the Device the
  event came from, so scenario 8's briefing plays on the Device whose Bluetooth
  connected.
- **Push is the doorbell.** A desktop long-polls, as a machine does today. A
  phone cannot, so a push (FCM now, APNs with the iOS client) tells it work is
  waiting, and it claims through the same routes. A push never carries the
  command.
- **Every command has a deadline.** A command still unclaimed at its deadline
  is `expired`, and the Bot is told it did not run. In scenario 9, with the Mac
  asleep, the Bot says the command is waiting for the Mac until then. It never
  guesses whether the command ran.
- **The Device keeps a ledger.** A Device records every `commandId` it has
  claimed and never runs one twice, even when a lease expiry offers it again.
  The Messages send ledger (`apps/mac-messages/send-ledger.ts`) already does
  this for sends; every mutating ability gets the same. Together with the
  queue's claim rule it makes a device command at-most-once.
- **Every Device kind may run commands,** within the abilities it carries and
  has consent for, not only a registered Mac.

### Shell commands are Jev's to decide

`exec` today asks the person, on an approval card, about every command. Once
Jev's enforced mutation review is live (step 3 of
[the Jev plan](../jev-supervision-plan.md)), `shell.exec` is a mutation like
any other:

- It runs when review finds the User's authorisation for it, either in the
  conversation or in durable policy, such as "you may always run `git pull` in
  `~/code` on my Mac".
- Otherwise the call is rejected with a reason, and the Bot asks in ordinary
  conversation.
- The card goes when review arrives. Until then `exec` keeps it, so shell never
  runs unreviewed.

Admission stays `chat` Turns only. Letting Routines run shell is a later
decision. The Mac app's helper gains `exec` behind its own consent.

A shell command cannot be undone. Seeing it is what the person gets: the
command line, working directory, exit status and bounded output go on the
Turn's log and in audit.

### In: entries

An **entry** is the person starting something from outside the conversation.
There are two kinds:

- **Content the person chose**, from the share sheet, open-with or a drop on
  the app. This is the person speaking: a user-lane message to the Bot they
  pick, with the content as attachments. Nothing today can carry a file that
  way, so `TurnCommand` gains attachments. A client uploads the bytes to an
  upload route first. They are stored content-addressed and admitted durably
  before the command naming them is acknowledged.
- **A gesture that names what to run**, from a widget or tile tap, a menu bar
  item, a notification action, a hotkey or an NFC tag. It runs what it names:
  - a Plugin handler, outside a Turn, as a Card press does;
  - a surface to open, through a deep link;
  - or a Routine firing.

  An NFC tag carries a deep link with an opaque token that maps to one
  Routine, using the same key the Routine webhook door already checks. The
  operating system can then open the app from the tag while the app is closed.
  Whoever writes the tag holds no more than that one firing.

### In: device triggers

A **device trigger** is a Routine trigger kind beside `schedule`, `webhook`,
`plugin` and `connection`:

```ts
{ kind: "device", deviceId: string, event: DeviceEventV1, params: {...} }
```

Its events include a geofence entered or left, a Bluetooth device connected or
disconnected, charging, and a network joined. Conversation authors it, as it
authors every Routine ([ADR 0033](0033-conversation-authored-routines.md)).

- **The cloud holds the Routine; the Device holds its arming.** An arming is
  the set of observations that Device must register with its OS. It is part of
  the Device's sync and is replaced whenever a Routine changes.
- **An event is admitted before it is acknowledged.** The Device posts it keyed
  by `(armingId, occurrence)`, and the app stores it durably before answering.
  A Device that retries is asking for the same firing.
- **The firing names its origin Device,** so a command can go back to it.

The platform decides what can be observed while the app is closed. Android
delivers geofences and Bluetooth broadcasts. iOS delivers geofences but not
arbitrary Bluetooth connections. There, scenario 8 is an App Intent the person
attaches to a Shortcuts automation ("when my car connects"), and it arrives as
an entry naming the Routine. Each ability records what it can and cannot do on
each platform, as the capability reference already does.

### Out: surfaces the host draws on the device

A home-screen widget, a watch tile and a Mac menu bar item cannot host a web
page on any platform. So these slots are host-drawn only:

- `device.widget`
- `device.tile`
- `device.menubar`

A Plugin view in one of them returns a **glance document**. Its vocabulary is
smaller than a settings section's: a title, up to four lines of text or
metrics, one image, and up to three actions. Each client maps it onto its own
widget kit.

- **Refresh.** When the Plugin's state changes, the same notice that redraws a
  panel pushes the new document to the Devices showing it, within the OS's
  refresh budget. The surface shows when it was last updated.
- **Taps.** A tap is an entry.
- **Placement.** Where a glance surface appears is the person's gesture on the
  Device, such as adding the widget, and that Device records it.

The menu bar item itself is host chrome: the Bots, their status and the host's
own quick actions. A Plugin's `device.menubar` view is one section inside it.
The Bot list stays trust chrome here as everywhere
([ADR 0034](0034-plugin-panels.md)), so no Plugin draws a Bot row.

### Approvals from the lock screen

A pending Approval reaches the User's Devices as a notification the host draws
from the kernel's record: what is proposed, its risk and its deadline. Approve
and Deny are bound to the `approvalId` only the kernel issued, and no Plugin
draws this notification.

- **Approve needs the Device unlocked.** It uses the OS's own authentication on
  the notification action. Deny does not, because a phone left on a table should
  be able to refuse but not consent.
- **An answer is recorded once.** It goes to the approval route with a
  `commandId` minted once per press, so a retried answer reads back the
  decision already stored.
- **The first Device to answer wins,** and the notification is withdrawn from
  the others.

Android can do this now over FCM. iOS follows its client.

### The browser extension is a Device

The browser extension is a new client kind with two abilities of its own and a
toolbar entry:

- **`browser.page.read`.** Page content reaches the Turn marked as page
  content: untrusted input, never the person's words.
- **`browser.page.fill`.** It fills fields, shows what it filled and never
  submits. The page's own submit is the person's press.

Both are own-machine abilities: first-party tools, reviewed by Jev.

### Not decided here

- Pages using device abilities: [ADR 0036](0036-plugin-html-surfaces.md).
- Letting Routines run shell.
- A Plugin handler taking part in approval decisions, and routing an inbound
  message to a Bot. Both appear on the capability reference, and each needs its
  own decision.
- An on-device model.
- The iPhone client and the browser extension as products. Each is its own
  plan, and scenarios on the iPhone wait for it.

## Scenarios, mapped

| #   | What carries it                                                                                |
| --- | ---------------------------------------------------------------------------------------------- |
| 1   | ADR 0036 page; `microphone` (local) on the Plugin's card; OS prompt on the Device              |
| 2   | ADR 0036 page; `camera` (local); the upload route carries the scan to the Bot                  |
| 3   | ADR 0036 page; no device ability                                                               |
| 4   | ADR 0036 page; `location` (local)                                                              |
| 5   | Device trigger: geofence on the phone's arming, a Routine firing                               |
| 6   | Entry with content: share sheet, upload route, a user-lane message                             |
| 7   | Entry by gesture: an NFC tag deep link carrying a Routine key                                  |
| 8   | Device trigger (Android) or App Intent entry (iOS); `audio.play` to `origin`                   |
| 9   | Device command `app.open` to the Mac; deadline, then `expired` if it slept through             |
| 10  | Device commands `alarm.set`, `timer.set`, `calendar.write`; push as the doorbell               |
| 11  | `shell.exec`, own-machine tier; approval card until Jev enforces, then Jev; Mac helper consent |
| 12  | Host-drawn approval notification; Approve needs unlock; first answer wins                      |
| 13  | `device.widget` glance document; tap is a Plugin handler                                       |
| 14  | `device.tile` glance document on a watch Device                                                |
| 15  | Host menu bar item; `device.menubar` sections                                                  |
| 16  | Browser extension Device; `browser.page.read` and `browser.page.fill`, never submitting        |

## Amendments to the constitution

On acceptance, `AGENTS.md` changes as follows:

- **The cloud is authoritative** gains its Device form: a Device observes and
  acts, while the Routine, the command and its outcome are the cloud's.
- **External effects are at-most-once by key** names device commands. A Device
  keeps a ledger and never runs a claimed `commandId` twice.
- **Self-modification never widens authority by itself** gains device
  abilities beside hosts and open network as the things a User may approve on a
  Plugin's card.
- **Extension points:**
  - **Grants** gains `device`: local and ordinary abilities, declared and
    approved once per account.
  - **Slots** gains `device.widget`, `device.tile` and `device.menubar`,
    host-drawn, opened as each client ships.
  - The Routine trigger kind `device` is app-owned, not a Plugin export.

`CONTEXT.md` gains **Device**, **Device ability**, **Entry**, **Device
trigger**, **Device command** and **Glance document**. The registered machine
folds into Device, and its terms go.

## Consequences

- One Device record replaces the push device and machine records. The
  machine registry, queue and routes become the Device's, the machine-listing
  tool becomes a device-listing tool, and pairing codes go. The stored records
  are cleaned up under the disposable-state rule, and a fresh conversation is
  verified.
- `TurnCommand` gains attachments, and the gateway gains an upload route that
  admits bytes durably before acknowledging.
- APNs arrives with the iOS client. Web push is optional and not planned.
- The native client gains arming sync, a share extension, NFC, geofence and
  Bluetooth observation, widget and tile hosts, a menu bar item, and the Mac
  helper's `exec`.
- The browser extension is a new deployable.
- The marketing capability reference loses its "Sidebar section" row. The Bot
  list stays trust chrome.

## Order

Each step leaves `main` shippable.

1. This document and ADR 0036, then the `CONTEXT.md` terms and `AGENTS.md`
   amendments on acceptance.
2. One Device record: fold the push device and the machine record together,
   put the label and platform on the Device, rename the listing tool, and run
   the cleanup.
3. Lock-screen approvals on Android. FCM exists, so this is the first scenario
   that needs only existing pieces.
4. Device commands to phones and the Mac: push as the doorbell, deadlines and
   the ledger. The first abilities are `alarm.set`, `timer.set`,
   `calendar.write`, `notification.show`, `audio.play`, `url.open` and
   `app.open`.
5. The upload route, then share sheet, deep-link and NFC entries.
6. Device triggers: arming sync, geofence, Bluetooth on Android, and the
   Routine kind.
7. The Plugin `device` grant, then glance surfaces: an Android widget and the
   Mac menu bar, and a watch after them.
8. Shell: the Mac helper's `exec` behind its consent, with the card. The card
   goes when Jev's enforced review ships.
9. The iOS client (APNs, App Intents, widgets) and the browser extension, each
   under its own plan.
