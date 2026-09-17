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

<!-- components: ImageGallery, FileAttachment, LinkPreview -->
