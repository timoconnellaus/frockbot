---
status: proposed
---

# One Browser, One Screen: A Computer Slot Is a Window, Not a Display

A Computer runs **one** Xvfb, **one** Chromium, and **one** CDP port. A Bot's slot is a 1280×720 rectangle of that one screen, holding one browser window pinned over it and one `x11vnc` clipped to it. The previous layout — one Xvfb, one browser launch, and one `x11vnc` per slot — is retired.

## Why the per-slot layout could not work

The browser profile is the User's. [ADR 0012](0012-one-computer-per-user.md) put every Bot of one User on one Computer sharing `/home/box/chrome-profile`, so that a login one Bot makes is a login all of them have. That is a requirement, not a convenience: a human takes a Computer over to sign in once, and every Bot is signed in.

Chromium's singleton lock is per `--user-data-dir`. A second launch against a profile a browser already holds does not become a second browser: it prints "Opening in existing browser session" and exits. The per-slot layout launched one browser per Bot against the one shared profile, so the first Bot to open a desktop got a browser and every Bot after it got nothing — a dead CDP port, a black screen, and a `box-doctor` report that only ever described the tenant that asked. Measured on a live Computer: one Chromium main process, four desktops, three of them black.

Two smaller defects came out of the same measurement and are fixed here:

- The viewer 404. `frockbot-viewer-gateway` kept serving `/usr/share/novnc` for days after a runtime update rewrote `start-gateway.sh` to serve FrockBot's own viewer. `createService` is a create-_or-update_ keyed by the definition, and the definition — `{cmd: start-gateway.sh, httpPort: 6080}` — never changes when what the update rewrites is the _contents_ of that launcher. Re-declaring it was correctly treated as a no-op. Picking up a rewritten launcher takes a restart, so the host now asks for one.
- The wallpaper dialog. With no `~/.fluxbox` at all, fluxbox writes its own defaults and applies the default style's background through `fbsetbg`, which is not installed; its failure is an `xmessage` dialog on every screen. A declared `~/.fluxbox/overlay` carrying `background: none` stops it reaching for one, and a declared `init` hides the toolbar the viewer had no reason to show.

## Considered options

- **A profile per Bot:** the obvious way to keep a browser per Bot. Rejected: it deletes the property the shared profile exists for. A login on Bot 1 would not be a login on Bot 2, and a User would sign in once per Bot.
- **A tab per Bot in one browser:** rejected. Tabs share a window, so two Bots would fight over what is on screen, and a viewer clipped to one Bot would show whatever the other last opened.
- **One window per Bot, on one screen:** chosen. Windows are independently placeable (`Browser.setWindowBounds`), independently raisable (`Page.bringToFront`), and a Bot may open as many tabs inside its own window as it likes.
- **`x11vnc -id <window>` rather than `-clip <rect>`:** rejected. A window id changes every time a Bot's window is re-created, and a VNC server bound to a dead window shows nothing. The rectangle is stable for as long as the Bot holds the slot.
- **A window manager at all:** kept, configured. CDP bounds hold without one, but a stacking WM is what makes takeover focus behave and costs one declared config file.

## What the layout is

- **Screen.** `frockbot-screen` runs one Xvfb on `:100` at `1280 × DESKTOP_SLOTS` by 720 — four slots, 5120×720 — plus fluxbox with a declared init.
- **Browser.** `frockbot-browser` runs one Chromium on `:100` with CDP on 9222 against the shared profile, supervised so a crash comes back. It removes a stale `SingletonLock` only when no browser process is running, and never the profile.
- **Window.** Each Bot's window is a CDP target recorded at `<bot>/target-id`, created with `Target.createTarget {newWindow: true}` and pinned with `Browser.setWindowBounds` to `x = slot × 1280`. It is re-created when it is gone, so a browser that crashed costs each Bot one new window on its next action.
- **Viewer.** `frockbot-view-<botKey>` runs one `x11vnc` per Bot on `5900 + slot`, `-clip 1280x720+<slot×1280>+0`.
- **Takeover.** Acquiring a lease raises that Bot's window. Releasing lowers nothing: the next takeover raises its own.
- **Slots.** Four, because the screen is a real framebuffer. A Computer whose every slot belongs to a live tenant refuses the next one rather than putting two Bots on one screen, exactly as before.

## Consequences

- **Isolation between two Bots of one User is weaker, and is accepted.** They share a profile, a process, a display, and a CDP port. Nothing at the CDP layer stops one Bot's helper enumerating another's targets; `browser.mjs` simply does not, and the reference set states the rule to the Bots. This is the same boundary [ADR 0012](0012-one-computer-per-user.md) already drew — "separation between Bots here is organizational, not a security boundary; the Computer is the User's trust boundary" — made concrete at one more layer. Two Users are still two Sprites, and that boundary is unchanged.
- **A Bot's `display` is `:100` on every Computer.** It used to be `:100 + slot`. Nothing downstream reads it as a slot.
- **The migration is part of the ordinary runtime update.** An existing Computer carries one `frockbot-desktop-<botKey>` service per tenant, one of whose browsers is holding the profile's lock. On the first open after this ships, the host lists services, stops and deletes every one of them, and declares the new layout. It runs once per Sprite per container, does nothing on a Computer that has none, and swallows every per-service failure: a platform that will not list or delete services must not cost a Bot its Computer. It removes **services**, never files — `/home/box/chrome-profile` is the User's login state and is not the migration's to touch.
- **Slots allocated under the hundred-display layout are pruned.** A slot past the edge of the screen is a window nobody can see and a clip `x11vnc` refuses, so the ensure script drops out-of-range slot files under the same lock that allocates them and the tenant re-allocates in range on its next open. A User with more than four Bots wanting screens at once now meets the "no desktop slots available" refusal that already existed, four Bots earlier than before.
- **`frockbot-chrome` takes no Bot key.** There is one display and one port to derive; the launcher holds the flags and nothing else.
- **`box-doctor` reports the Computer rather than the caller.** `tenant-display-<botKey>` for every tenant that holds a slot (window alive, window over its own slot), plus `browser-process` (exactly one), `browser-cdp`, and `screen`. One Bot's report being healthy is precisely how three black screens went unnoticed.
