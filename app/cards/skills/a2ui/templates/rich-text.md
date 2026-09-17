# Rich text

_A reference of `managed/a2ui`. The tables below are generated from the
catalogs the app draws; do not edit them by hand._

## When to use

`Text` is one run of characters in one style. These three are the other ways
words appear on a card.

- **`Markdown`** — anything with structure in it: a summary with bullets, a
  short explanation with a heading, a paragraph with a link. It is drawn by
  the same renderer as your own chat messages, in the same subset.
- **`CodeBlock`** — a command, a payload, a snippet. Monospaced, indentation
  kept, with a control that copies it. **Never put code in a `Text`** — it
  will wrap and stop being the code.
- **`Quote`** — words that are not yours: the message being replied to, the
  line of the document under discussion.

Long prose the card is _about_ — a draft you are asking someone to approve —
is `CollapsibleText` (`frock.md`), not `Markdown`: it starts collapsed, so the
controls stay in view.

## What Markdown draws

Headings, bullet and ordered lists, fenced and indented code, block quotes,
rules, and inline emphasis, code, links and images-as-links. Single newlines
are meaningful, as they are in chat. Anything outside that subset is shown as
the characters you wrote, and **no HTML is ever rendered** — there is no HTML
in the renderer to render.

A link in Markdown opens through the app's own link handling, and only when it
is `https://`.

```json
{
  "id": "summary",
  "component": "Markdown",
  "text": "**Three things changed**\n\n- the retainer is monthly now\n- the scope covers support\n- the rate is unchanged"
}
```

## Code is copied, not read

Give `CodeBlock` the text exactly as it should be pasted, with no surrounding
backticks — the box is the fence. `language` is a label above it, not syntax
colouring; it tells the person what they are looking at.

## Components

<!-- components: Markdown, CodeBlock, Quote -->
