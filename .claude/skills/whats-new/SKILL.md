---
name: whats-new
description: Add or update a What’s New entry when a user-facing feature, improvement, or fix ships in the desktop or mobile app. Use when the user says what’s new, changelog, ship notes, or when finishing a change people will see after an update. The pull request must show the still so it can be reviewed.
---

# What’s New

A curated in-app list of what production shipped. Dates come from the first
production tag, not the pull request. The still is reviewed on the PR.

## When to add an entry

Add one in the **same PR as the feature** when a person using the installed
app would notice the change after an update.

Skip refactors, docs, infra, tests, and anything that is not user-visible.

## Add the entry

1. Put a WebP in `app/whats-new/media/<id>.webp` if the entry has a picture.
   Slug filename, under 200 KiB. Same-origin only — not a Flutter asset, not
   a CDN.
2. Prepend the entry to `WHATS_NEW_ENTRIES_V1` in `app/whats-new/entries.ts`
   (newest first):

   ```ts
   {
     id: "search",
     title: "Search across every Bot",
     summary: "Find a conversation, a file, or a person.",
     kind: "feature",
     image: { file: "search.webp", alt: "Search results across Bots." },
   }
   ```

3. Generate the review surface and the Worker embed:

   ```bash
   bun app/whats-new/generate.ts
   bun test app/whats-new
   ```

`id` is a stable slug. Renaming one is a new entry; reusing one inherits the
earlier tag’s date. Do not set `publishedAt` — the first `vX.Y.Z` tag that
contains the id is the day, and until then the row says “New”.

`kind` is `feature`, `improvement`, or `fix`.

## Copy

The title names the thing. The summary is what landed, one or two sentences.

Do not explain how to find it, how it works, or what to tap. The page already
says What’s New.

## The still

The picture is the feature, not chrome around it.

- No page header — the app already has What’s New at the top.
- No profile sheet, Account group, or Personal details.
- No how-to inset showing where the row lives.
- Alt text says what the picture shows.

The pull request is the review. `PREVIEW.md` links the still. A PR that
touches `app/whats-new/**` posts (or updates) a sticky comment with the
stills from the branch head. Put the picture in the PR body too.

## What not to do

- Do not invent a merge day or a ship day.
- Do not bake stills into Flutter assets (that forces a full Android APK).
- Do not point `src` at an external host. CSP is same-origin.
