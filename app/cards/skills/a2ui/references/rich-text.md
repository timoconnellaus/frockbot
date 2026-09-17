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

### `Markdown`

A body of Markdown, drawn the way the Bot's own messages are: headings, bullet and ordered lists, emphasis, inline code, block quotes, rules and links. Use it for anything with structure in it; use Text for one plain run.

| Property | Type          | Required | Binding  | What it is                                                                                                                                                           |
| -------- | ------------- | -------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text`   | DynamicString | yes      | bindable | The Markdown source. The subset the app draws is the one it draws chat messages with; anything else is shown as the characters you wrote. No HTML is rendered, ever. |

```json
{
  "id": "root",
  "component": "Markdown",
  "text": "…text…"
}
```

### `CodeBlock`

Code, a command, or a payload, in a monospaced box with a control that copies it. Use it whenever the person might need the text exactly — never a Text, which will wrap and lose the indentation.

| Property   | Type          | Required | Binding  | What it is                                                                                                                                      |
| ---------- | ------------- | -------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `code`     | DynamicString | yes      | bindable | The text, exactly as it should be copied. Do not wrap it in backticks.                                                                          |
| `language` | string        | no       | literal  | What it is, drawn as a label above the box: 'bash', 'json', 'dart'. There is no syntax colouring; this only says what the person is looking at. |
| `caption`  | string        | no       | literal  | One line under the box: where it came from, what it does.                                                                                       |

```json
{
  "id": "root",
  "component": "CodeBlock",
  "code": "…code…"
}
```

### `Quote`

Something somebody else wrote, set apart from the card's own words: the message being replied to, the line of a document under discussion. Never for the Bot's own text.

| Property      | Type          | Required | Binding  | What it is                                                                                       |
| ------------- | ------------- | -------- | -------- | ------------------------------------------------------------------------------------------------ |
| `text`        | DynamicString | yes      | bindable | The quoted words. Keep it to the part that matters; a long quotation belongs in CollapsibleText. |
| `attribution` | DynamicString | no       | bindable | Who said it, and when: 'Nick, Tuesday 9:14am'.                                                   |

```json
{
  "id": "root",
  "component": "Quote",
  "text": "…text…"
}
```
