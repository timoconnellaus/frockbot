---
name: whats-new
description: Add or update a What’s New entry when a user-facing feature, improvement, or fix ships in the desktop or mobile app. Use when the user says what’s new, changelog, or ship notes, or when finishing a change people will see after an update. The pull request must show the still so it can be reviewed.
---

# What’s New

A curated in-app list of what production shipped. Not GitHub release notes
and not Sparkle notes. Dates come from the first production tag, not the
pull request. The still is reviewed on the PR.

Adding an entry is ordinary catalog work: one row, maybe a WebP, then
generate. Do not rebuild the feed, unread mark, or auto-open path to add
one.

## When to add an entry

Add one in the **same PR as the feature** when a person using the installed
app would notice the change after an update.

One entry per noticeable thing. Prepend it to `WHATS_NEW_ENTRIES_V1`
(newest first).

Skip refactors, docs, infra, tests, and anything that is not user-visible.

## Add or edit

Unreleased (no production `vX.Y.Z` tag contains the id yet): edit the row
in place.

Shipped: leave the id alone. A new thing is a new id. Fix a typo if the
copy is wrong; do not rewrite what already shipped.

`id` is a stable slug (`^[a-z0-9][a-z0-9-]{0,63}$`). Renaming one is a new
entry; reusing one inherits the earlier tag’s date. Do not set
`publishedAt` — the first `vX.Y.Z` tag that contains the id is the day, and
until then the row says “New”.

`kind` is `feature`, `improvement`, or `fix`.

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

The title names the thing. The summary is what landed, one or two sentences.

Do not explain how to find it, how it works, or what to tap. The page already
says What’s New.

## The still

A feature with a surface to show gets a picture, so the PR can review it.
A copy-only fix may skip one.

The picture is the feature, not chrome around it.

- No page header — the app already has What’s New at the top.
- No profile sheet, Account group, or Personal details.
- No how-to inset showing where the row lives.
- Alt text says what the picture shows.

Capture from the real UI or a browser render with the product font. Flutter
widget-test screenshots use Ahem — they are not the still.

The pull request is the review. `PREVIEW.md` links the still. A PR that
touches `app/whats-new/**` posts (or updates) a sticky comment with the
stills from the branch head. Put the picture in the PR body too.

## What not to do

- Do not invent a merge day or a ship day.
- Do not bake stills into Flutter assets (that forces a full Android APK).
- Do not point `src` at an external host. CSP is same-origin.
- Do not hand-edit `PREVIEW.md` or `media.generated.ts`.
