# Frock UI

The design system every FrockBot surface builds from: the web shell, the Flutter app, Applets, A2UI plugin UI, and plugin web fallbacks. One vocabulary, one set of numbers, so a screen built in HTML and the same screen built in Flutter match.

## The direction (accepted 2026-09-05)

**The app is your Bots' office. Chat is one room in it.**

- Chat with a Bot is the primary screen and the home: the last Bot's chat opens instantly. The flock lives in a drawer, not a tab bar. What needs you and what happened are surfaced inside chat and the drawer, not on a separate Today screen (decision 2026-09-05).
- Every Bot action is a **receipt**: an icon tile, a verb-first sentence, a mono time. The same object appears on a Bot's Work tab, in the briefing, and in the Computer. **Never in chat** (Tim, 2026-09-05): the thread is the Bot's words only, the way it is on the web; what the Bot did is a different room.
- Bots are **characters**: sheep avatars with a state ring (pink working, green ready, grey idle), names set in the display face.
- The accent is **light**, not paint: a glow behind the working Bot, a glow under the one pink pill per screen. Everything else is tone on tone.
- **Tone before line**: four depths (ground, window, sheet, tile), three ink tiers as alpha, hairlines only inside a group and starting at the text edge.
- **Small, quiet type**: messages at 15px on a phone, chrome at 14 and below, nothing under 20px heavier than 600. Archivo Black only for greetings, Bot names, and big numbers.

## Voice (spec, 2026-09-05; designed as screens 11 and 12 on frock-ui.html and `FrockVoiceScreen` in the gallery; not built yet)

Voice is **the whole app screen**, not a sheet over chat. It has a **Pause** control that stops the Gemini session outright. Bots do not know the assistant is paused: anything they send while paused is queued, and on unpause the queue is handed to the voice agent to work through with the person. The paused screen must show that Bots have written while paused (a count on the resume control), so the person knows there is a reason to come back. Four states to design: live, paused and quiet, paused with messages waiting, resuming.

## Files

- `frock-ui.html` — the system: colour, type, space and shape tokens, components, and the reference screens. Open it in a browser. This is the source of truth for both platforms until `tokens.json` drives generated CSS and Dart.
- `tokens.json` — the token values in one machine-readable file. Names match the `--frock-*` CSS custom properties in `packages/plugin-ui-theme` and the `FrockTokens` names in `apps/native/lib/theme`.
- `explorations-chat-directions.html` — ten different directions for the chat screen, kept for the record.
- `explorations-foundations.html` — the earlier foundations pass (two densities, base components), superseded by `frock-ui.html` but still the reference for desktop compact values.

## Sequencing

1. HTML system and reference screens (this folder). Done.
2. Wire `tokens.json` into `packages/plugin-ui-theme` so the shell, the Applet kit and A2UI consume generated CSS.
3. Flutter port: `FrockTokens` theme extension and widgets mirroring each component here.
4. Match check: the same screens rendered by Playwright at 390px and by the Flutter render test with the real fonts and a simulated safe area, side by side, in `docs/design/evidence/` (Chat first).
