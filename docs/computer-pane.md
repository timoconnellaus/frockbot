# Computer pane

**Status:** design. Not built.

The Bot's browser is already on screen: one Chromium window pinned to that
Bot's 1280×720 slot. Watching it today means opening the full-window Computer
viewer. This design puts that same live view beside the conversation, so a
Turn that drives `computer_browser` is something you can see without leaving
the chat.

It is not a Canvas. A Canvas is the Applet surface. It is not a new browser
host, a CDP screencast, or a second viewer protocol. The pane frames the
viewer the card and the full window already use.

Current shape: [`architecture.md` §6](architecture.md#6-clients) (card and
full window) and [§10](architecture.md#10-computer) (slot, VNC, connect).
GrokBot's info-pane preview is the nearest parity row
([`grokbot-parity.md`](grokbot-parity.md) row 51); this is that preview
grown into the destination, not a thumbnail that launches the desktop.

## 1. Decision

Add a **Computer pane**: a shell column beside the conversation that frames
the Bot's Computer screen.

- One widget, `ComputerPane`, over the existing `ComputerViewerFrame` and
  `ComputerController`.
- Opening the pane is the watch gesture: it calls `open()` and mints a
  viewer, the same as today's full window.
- The full-window viewer stays for widths that cannot hold the pane, for
  voice mode, and as an explicit expand.
- The Bot page card stays the idle photograph. It does not grow into the
  pane, and drawing it still wakes nothing.
- The host, the slot, `computer_browser`, and the viewer credential model
  do not change in this slice.

User-facing name stays **Computer**. The pane is the Computer; the picture
in it happens to be the browser.

## 2. Why this shape

There is no separate "Bot browser" surface. `computer_browser` returns an
accessibility snapshot. The pixels are the slot's VNC. A second video path
would be a second secret, a second CSP origin, and a second thing to bill.

The Applet canvas is the wrong slot. It holds an Applet viewer token, it is
a full window at every width, and a 380-point column is already declared
"not where you read an Applet." The Computer's credential is a bearer
viewer URL. The two frames share a host-chrome pattern, not a widget.

The Bot page card is the wrong destination. It is a 16:10 strip in a 380-point
panel, and "Open" pushes a fullscreen route. Watching a page needs a column
that is the screen, with Take control in that column, not a thumbnail.

380 points of 1280×720 is a postage stamp (~214 points tall). The pane
therefore asks for more width than the Bot page, and only where the
conversation can spare it.

## 3. Layout

The shell keeps its three tiers. The pane is a **mode of the right column**
at the widest tier, not a fourth column and not a `HotPanelStack` page.

Framed WebViews stay out of the hot-door set: a mounted-offstage VNC iframe
is a tab nobody asked to keep, and it would keep a billed viewer alive
while someone reads Routines.

| Width | What watching does |
| --- | --- |
| ≤ 640 (phone) | Full-window viewer, unchanged. Rotating back from landscape still closes it. |
| 640–980 (dual) | Full-window viewer. A drawer over the conversation is not beside the chat. |
| 980–1279 (narrow triple) | Full-window viewer. Growing the 380-point panel would leave the thread unreadable. |
| ≥ 1280 | Computer pane is the right column. |

`1280` is `shellComputerInlineWidth`. Below it there is no pane, so there
is no bad pane.

When the pane is open:

```
sidebar 288 | conversation (flex, ≥ 440) | Computer pane 480–560
```

The pane width is `clamp(window - 288 - 440, 480, 560)`. At 1280 that is
480. At 1400 and above it sits at 560. The Bot page column is parked —
mounted, offstage, the way a collapsed panel already is — and comes back
when the pane closes.

One right-hand column, never two. Settings, Routines, a run, or an
exchange keep the column they already have; the pane yields rather than
stacking beside them.

Voice mode is unchanged: the Computer icon still opens the full window.
The call has already taken the thread.

## 4. Watching and cost

Viewer time is prepaid in 30-second blocks while a visible client
heartbeats ([`billing.md`](billing.md)). The card's rule stands: **drawing
the Bot page wakes nothing**. The pane is different because opening it is
asking to watch.

| Gesture | Viewer |
| --- | --- |
| Bot page card, idle or mid-Turn | Snapshot. No `connect`. |
| Open the pane (header, card, search, auto-open) | `ComputerController.open()` — mint or attach a viewer. |
| Pane on screen, streamable phase | Live frame. `computerStreamsV1` with `onScreen: true` and `expanded: true`. |
| Close the pane, or collapse the column | `closeViewer`. Do not pay for an invisible stream. |
| Turn settles while the pane is open | Keep the pane. Stream for `computerLivePreviewGraceV1` (15s), then the last capture. Do not auto-close. |
| Leave the Bot | Close the viewer. A Bot switch already tears the controller down. |

Auto-open is the thing that makes "I don't have to open the VM" true. It
fires only when all of these hold:

- the window is at or above `shellComputerInlineWidth`;
- a running Turn has a `computer_browser` call (`botComputerBrowserRunningV1`
  — narrower than today's `botComputerRunningV1`, which matches any
  `computer_*` tool);
- the right column is the Bot page, or is collapsed. A pushed Settings,
  Routines, Plugins, run, or exchange page is left alone.

Auto-open calls `open()` and uncollapses the column. That starts billing.
Closing the pane is how watching stops.

`computer_exec`, doctor, and process tools do not auto-open: there is
often no page to watch. A pane the User already opened keeps streaming
for any Computer work, because `expanded` is already true.

Projection reads still never renew a paid viewer. Recovery stays on
`connect` with a durable effect key.

## 5. Chrome

One row, then the frame.

- Title: `Computer`, or `Computer · <Bot>` when the name is not already
  the conversation's.
- The status line the card already speaks: Live, the last capture's age,
  connecting, or what refused.
- **Take control** / **Release control**, same confirmation as the full
  window (`confirmComputerTakeControlV1`). The frame's `controlling` flag
  flips on the same minted URL. The User-wide `desktop-gui` lease does
  not change.
- **Expand** opens today's `ComputerViewerPage`. Useful for a login, a
  captcha, or a dual-width window that cannot hold the pane.
- **Close** returns the column to the Bot page and closes the viewer.

The body is the same three states the card and the full window already
draw: `ComputerOpening`, the live `ComputerViewerFrame`, or the stored
capture. The frame letterboxes 16:9 (the slot is 1280×720) inside the
column. Do not crop, rotate, or scale the stream to fake a phone.

View-only until Take control, as today. Tapping the frame while
view-only does not send input; it can reveal the Take control control
the way the full window already does.

## 6. Doors

On a desk wide enough for the pane, the conversation chrome grows the
Computer control it already shows on a phone. The cooler blue
(`computerRunningColor`) still means the Bot is driving the Computer.
Pressing it toggles the pane.

The Bot page card's Open opens the pane at `shellComputerInlineWidth`
and above, and the full window below that. Search's Computer action
does the same.

`ComputerIds.pane` is the pane's identifier. The full-window viewer
keeps `ComputerIds.viewer`. Specs that mean "the desktop filled the
window" stay on the viewer; specs that mean "I can see the Bot's page
beside the thread" select the pane.

## 7. What this is not

- **Not a Canvas.** Do not reuse `AppletCanvas`, the applet open path,
  or the applet viewer token.
- **Not a panel-stack page.** Do not add `computer` to `hotPanelDoors`.
- **Not a browser-only host API.** Fluxbox is already minimal; the slot
  is the Chromium window. Clipping VNC to a window id was rejected
  because the id dies when the window is recreated.
- **Not a portrait viewport.** The pane is a tall column around a
  landscape page. A phone-shaped page the Bot actually clicks is a host
  change: `capabilities.desktop` width and height, the Chromium window,
  and the VNC clip. Same pane widget; different slot. That is a later
  slice, not a client crop.
- **Not a CDP screencast.** App code must not name the desktop stack
  (`novnc`, `x11vnc`, …). The import gate stays.

## 8. Implementation

Ordinary Flutter in the native client. No protocol change.

| Piece | Where |
| --- | --- |
| Pane widget | `apps/native/lib/computer/pane.dart` — chrome + the three body states, taking `ComputerController` |
| Width gate | `apps/native/lib/shell/desktop_layout.dart` — `shellComputerInlineWidth`, `shellComputerPaneWidth` (min 480, max 560), conversation floor 440. `ShellLayout` accepts a panel width so the Bot page stays 380 |
| Shell mode | `apps/native/lib/shell/app_shell.dart` — `computerPaneOpen`; header `onComputer` at the inline width; auto-open on `botComputerBrowserRunningV1`; yield to run / exchange / pushed panel pages; closeViewer on close, collapse, and Bot switch |
| Card door | `apps/native/lib/computer/card.dart`, `bot_page.dart` — Open follows the width gate |
| Running mark | `apps/native/lib/computer/client.dart` — `botComputerBrowserRunningV1` next to `botComputerRunningV1` |
| Semantics | `apps/native/lib/shell/semantics.dart` — `ComputerIds.pane` |
| Card `onScreen` | `ComputerCard` should take `PanelVisibility.of(context)` rather than hardcoding `true`, so an offstage Bot page does not keep a frame live |

Tests that already pin the full-window route (`computer-presence.e2e`,
`computer_orientation_test`, the card's Open) stay true below the inline
width. New cases:

- at 1400, Computer opens the pane and does not push `ComputerViewerPage`;
- at 980, Computer still opens the full window;
- auto-open on `computer_browser`, not on `computer_exec`;
- auto-open does not steal Settings or a run;
- closing or collapsing the pane issues `closeViewer`;
- Take control in the pane uses the same confirmation;
- phone and voice still open the full window.

When it ships, [`architecture.md` §6](architecture.md#6-clients) replaces
"the Computer is not a panel entry" with this column, and
[`CONTEXT.md`](../CONTEXT.md) gains **Computer pane** under Computer:
the surface beside the conversation that frames the Bot's screen. Closed
until opened; on a phone the full-window viewer is the same destination.

## 9. Later

A portrait slot — `capabilities.desktop` as something like 390×844, one
window and one clip — is the way the pane becomes a phone-shaped
browser. It is host work. Do not pretend with CSS.

Projecting `computer_browser`'s url and title onto the pane chrome is
a small protocol addition and can follow. v1 lets the picture speak.

The Kubernetes host ([`kubernetes-computer-host-plan.md`](kubernetes-computer-host-plan.md))
implements the same `ComputerHostV1` viewer. The pane does not care
which host minted the URL.
