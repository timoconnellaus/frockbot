# Text and media

_A reference of `managed/a2ui`. The tables below are generated from the
catalogs the app draws; do not edit them by hand._

## When to use

`Text` carries nearly everything a card says. Give the card's title `"variant":
"h3"` or `"h4"` and leave the rest at the default body style; a card is not a
document, and a stack of headings reads as one.

Simple Markdown works inside `Text` — emphasis, a bullet list — but no HTML, no
images and no links. A link is a `Button` with an `openUrl` action (see
`actions.md`), and an image is an `Image`.

For a long body — a draft, a quote, anything that would push the controls off
the screen — use `CollapsibleText` from `frock.md` instead of a `Text`.

**Media is https only.** A `url` that is not `https://` refuses the whole
surface. Only link to something you were actually given a URL for; do not
invent one, and do not embed a video or an audio player unless the User asked
for that thing.

`Icon` takes a name from a fixed set, so check the table before using one. An
icon on its own says very little — pair it with a `Text` in a `Row`, or skip
it.

## Components

<!-- components: Text, Image, Icon, Video, AudioPlayer -->
