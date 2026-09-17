# Media

_A reference of `managed/a2ui`. The tables below are generated from the
catalogs the app draws; do not edit them by hand._

## When to use

The standard catalog's `Image` is one picture and nothing else. These three
are what a card needs when it is showing something the Bot found or made.

- **`ImageGallery`** — one picture, or several. One draws full width; several
  draw as a strip you can scroll. Tapping one opens it. Use this rather than
  a `Row` of `Image`s.
- **`FileAttachment`** — a document, an export, a generated artifact: one row
  saying what it is, with a control that opens it.
- **`LinkPreview`** — a page, with enough of what is behind it that the person
  can decide before following it. A bare link inside a sentence belongs in
  `Markdown`.

## Links are the host's

Every link in this family is `https://`. A card carrying any other scheme is
**refused whole** — the person sees an unavailable region instead of your card,
not a card with one part missing. That is true of `url` and `imageUrl` alike,
at any depth.

Following a link opens it the way the rest of the app opens one. It costs no
Turn and no revision: you will not hear about it, and you should not write an
`action` on any of these to try to.

## Write the alt text, and the size

Nothing is derived for you:

- `ImageGallery`'s `alt` is what a person who cannot see the picture is told.
  Write one for every image.
- `FileAttachment`'s `detail` is already-formatted words — `"PDF · 1.2 MB"` —
  because there is no formatting function that will turn bytes into that
  later.

```json
{
  "id": "export",
  "component": "FileAttachment",
  "name": "September invoices.pdf",
  "detail": "PDF · 1.2 MB",
  "kind": "document",
  "url": "https://example.com/exports/september.pdf"
}
```

## Components

### `ImageGallery`

Several pictures in one component: what was found, what was generated, the pages of a document. One image draws full width; more than one draws as a strip that scrolls. Tapping one opens it.

| Property | Type                                                     | Required | Binding | What it is                                 |
| -------- | -------------------------------------------------------- | -------- | ------- | ------------------------------------------ |
| `images` | array of { url: string, caption?: string, alt?: string } | yes      | literal | The pictures, in the order they are shown. |

```json
{
  "id": "root",
  "component": "ImageGallery",
  "images": [
    {
      "url": "…url…"
    }
  ]
}
```

### `FileAttachment`

A file the card is about: a document, an export, a generated artifact. One row with what it is and a control that opens it.

| Property | Type                                                                                           | Required | Binding  | What it is                                                                                                                                                         |
| -------- | ---------------------------------------------------------------------------------------------- | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`   | string                                                                                         | yes      | literal  | The file's name, as the person would recognise it.                                                                                                                 |
| `detail` | DynamicString                                                                                  | no       | bindable | What is worth knowing about it, already in words: 'PDF · 1.2 MB', 'Generated just now'. There is no formatting function; write the size the way a person reads it. |
| `kind`   | `document` \| `spreadsheet` \| `image` \| `audio` \| `video` \| `archive` \| `code` \| `other` | no       | literal  | What sort of file it is, which is the icon the host draws. Defaults to 'other'.                                                                                    |
| `url`    | string                                                                                         | no       | literal  | An https:// link to the file. With one the row offers to open it, through the app's own link handling; without one it is a row that says the file exists.          |

```json
{
  "id": "root",
  "component": "FileAttachment",
  "name": "…name…"
}
```

### `LinkPreview`

One link, with enough of what is behind it that the person can decide before they follow it. Use it for a page a Bot found or made; a bare link inside prose belongs in Markdown.

| Property      | Type          | Required | Binding  | What it is                                                             |
| ------------- | ------------- | -------- | -------- | ---------------------------------------------------------------------- |
| `url`         | string        | yes      | literal  | Where it goes. https:// only, and the whole card is refused otherwise. |
| `title`       | DynamicString | yes      | bindable | What the page is called.                                               |
| `description` | DynamicString | no       | bindable | A line or two about it. Two lines at most are drawn.                   |
| `site`        | string        | no       | literal  | Whose page it is, e.g. 'example.com'. Defaults to the link's own host. |
| `imageUrl`    | string        | no       | literal  | An https:// thumbnail beside the title.                                |

```json
{
  "id": "root",
  "component": "LinkPreview",
  "url": "…url…",
  "title": "…title…"
}
```
