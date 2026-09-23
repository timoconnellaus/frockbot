---
name: whats-new
description: Add or update a What’s New entry when a new feature people would care about ships in the desktop or mobile app — never for a bug fix or a tweak. Use when the user says what’s new, changelog, or ship notes, or when finishing a new feature. The pull request must show the still so it can be reviewed.
---

# What’s New

A curated in-app list of what production shipped. Not GitHub release notes
and not Sparkle notes. Dates come from the first production tag, not the
pull request. The still is reviewed on the PR.

Adding an entry is ordinary catalog work: one row, maybe a WebP, then
generate. Do not rebuild the feed or the unread mark to add one.

## When to add an entry

Add one in the **same PR as the feature** when it is a new thing a person
using the installed app would care about. Noticing a change is not enough:
it has to be new.

One entry per feature. Prepend it to `WHATS_NEW_ENTRIES_V1`
(newest first).

Skip bug fixes, tweaks, polish, refactors, docs, infra, tests, and anything
that is not user-visible.

## Add or edit

Unreleased (no production `vX.Y.Z` tag contains the id yet): edit the row
in place.

Shipped: leave the id alone. A new thing is a new id. Fix a typo if the
copy is wrong; do not rewrite what already shipped.

`id` is a stable slug (`^[a-z0-9][a-z0-9-]{0,63}$`). Renaming one is a new
entry; reusing one inherits the earlier tag’s date. Do not set
`publishedAt` — the first `vX.Y.Z` tag that contains the id is the day, and
until then the row says “New”.

A new entry’s `kind` is `feature`.

1. Put a WebP in `app/whats-new/media/<id>.webp` when the entry has a
   picture. Slug filename, under 200 KiB. Same-origin only — not a Flutter
   asset, not a CDN.
2. Prepend the entry to `WHATS_NEW_ENTRIES_V1` in `app/whats-new/entries.ts`:

   ```ts
   {
     id: "search",
     title: "Search across every Bot",
     summary: "Find a conversation, a file, or a person.",
     kind: "feature",
     image: { file: "search.webp", alt: "Search results across Bots." },
   }
   ```

3. Generate the review surface and the Worker embed. Do not hand-edit
   `PREVIEW.md` or `media.generated.ts`.

   ```bash
   bun app/whats-new/generate.ts
   bun test app/whats-new
   ```

## Copy

Write like the rest of the app, not like a changelog and not like a launch
post. The empty state is the voice: “When something ships that is worth a
look, it lands here.”

The title names the thing, sentence case, no version and no “New:”. The
summary is what landed — one short sentence, two if a second fact is
needed. Present tense. The same words the UI uses (Bot, What’s New).

Do not explain how to find it, how it works, or what to tap. The page
already says What’s New.

| Use                                       | Do not use                                                          |
| ----------------------------------------- | ------------------------------------------------------------------- |
| Search across every Bot                   | New: powerful global search                                         |
| Find a conversation, a file, or a person. | You can now open Search from the sidebar to look across Bots.       |
| What landed in each release.              | This update adds an in-app changelog. Tap What’s New under Account. |

Leave out marketing adjectives, “you can now”, “we’ve added”, emoji,
ticket numbers, and PR numbers. `kind` is metadata, not copy.

## When to use a still

Use one when the change has a surface you can point at — a page, a card,
a control, a result. The picture is what you would show someone to say
what shipped, and the PR reviews it there.

Skip the picture when there is nothing to see. Do not decorate. An icon, a
gradient, or a screenshot of chrome around the feature is not a still.

## The still

The card draws it at 16:9 with `BoxFit.cover`, and a tap opens the same
frame larger. Compose for that frame.

- 16:9, at least 1200×675. Keep the subject in the middle — cover crops
  the edges.
- Real product UI, product type (Inter on the default theme). Type must
  stay sharp at card width and when enlarged. If the words go mushy, the
  still is not done.
- WebP, under 200 KiB, same-origin only — not a Flutter asset, not a CDN.
  Small is fine; unreadable is not.
- No What’s New page header, no profile sheet, no Account group, no
  Personal details, no how-to inset, no status bar, no window chrome.
- Alt text says what the picture shows.
- Default dark theme unless the feature only exists on paper.

Capture from the real UI or a browser render with the product font.
Flutter widget-test screenshots use Ahem — they are not the still. Do not
photograph a monitor. Do not invent UI.

The pull request is the review. `PREVIEW.md` links the still. A PR that
touches `app/whats-new/**` posts (or updates) a sticky comment with the
stills from the branch head. Put the picture in the PR body too.

## What not to do

- Do not invent a merge day or a ship day.
- Do not bake stills into Flutter assets (that forces a full Android APK).
- Do not point `src` at an external host. CSP is same-origin.
- Do not hand-edit `PREVIEW.md` or `media.generated.ts`.
- Do not ship a still whose type is soft, or UI that is not in the product.
