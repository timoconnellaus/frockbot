# Pages

A `conversation.panel` view may be an HTML page you write, drawn in the
host's sandboxed frame beside the conversation. Use one only when the surface
is its own drawing or interaction — a board the person drags on, a canvas, a
live meter. Anything a list, a form or a status line can show belongs in a
host-drawn view (`panels.md`): it is themed, accessible and works everywhere.

Name the file on the view, and write it beside `plugin.json`:

```json
"views": [
  { "slot": "conversation.panel", "surfaceId": "score", "label": "Score", "page": "score.html" }
]
```

The view's function returns the page's **state** — any JSON object up to
64 KB — instead of a tree. The page is handed it on load and again whenever
the panel is read after a change:

```ts
export const views = {
  score: async (ctx) => {
    const stored = await ctx.storage?.get({ key: "score" });
    return { score: stored?.status === "available" ? stored.value : 0 };
  },
};
```

## The page

One self-contained HTML file of at most 512 KB: every script and style
inline. The frame loads nothing from anywhere — no CDN, no image URL, no
font, no `fetch`, no socket — and holds no credential. Use `data:` URLs for
images. The page is untrusted code on the person's device; it reaches this
Bot only through your Plugin's own tools.

A bridge is added to the page when you publish, as `window.frockbot`:

- `await frockbot.ready` — `{ pluginId, botId, surfaceId, themeTokens, state }`.
  Every theme token is also set as a CSS variable, `--frockbot-<name>`:
  `surface`, `text`, `text-muted`, `border`, `accent`, `on-accent`,
  `danger`, `font-sans`, `text-sm`, `radius-control` and more.
- `frockbot.state` — the latest state; `frockbot.onState(fn)` is called with
  each new one and returns its unsubscribe.
- `await frockbot.callTool(name, input)` — runs one of this Plugin's tools
  outside any Turn and resolves with its text, or rejects with the reason.
- `frockbot.log(text)` — reports a reading to you, such as the input level a
  tuner hears. Errors the page throws or leaves unhandled, and every
  `console.error`, are reported the same way without you asking.

```html
<!doctype html>
<html>
  <head>
    <style>
      body {
        font: var(--frockbot-text-base) var(--frockbot-font-sans);
        color: var(--frockbot-text);
        background: var(--frockbot-surface);
      }
    </style>
  </head>
  <body>
    <p id="score">…</p>
    <button id="add">Add one</button>
    <script>
      const show = (state) => {
        document.getElementById("score").textContent = String(state.score);
      };
      frockbot.ready.then(({ state }) => show(state));
      frockbot.onState(show);
      document.getElementById("add").onclick = async () => {
        await frockbot.callTool("score_add", {});
      };
    </script>
  </body>
</html>
```

After a tool the page called, the panel is read again and the page gets the
new state. Keep the truth in `ctx.storage`, never only in the page: the frame
is torn down when the person leaves the panel.

A page may listen to the microphone through the host: see `microphone.md`.

## Seeing it fail

The page runs on the person's device, never here, and you cannot open it
yourself. `plugin_page_reports` with the Plugin's id is how you see it: the
errors and logs its pages reported, newest first, with the device and the
version each came from. Read it after the person has used a page, and before
you change one they say misbehaves. Something that is wrong but throws
nothing, like a threshold the room never reaches, only shows up if the page
logs the reading: log what you would want to know.

`plugin_check` and `plugin_publish` refuse a view whose page file is missing.
The approval card tells the User the Plugin draws its own page.
