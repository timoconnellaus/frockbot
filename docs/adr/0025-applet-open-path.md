# ADR 0025: Open an Applet in one round trip

Status: accepted, 2026-09-11. Numbered after ADR 0024, the last of the set
`docs/plan.md` retired; nothing on `main` or in an open pull request holds 0025.

## Context

Opening an Applet is slow, and the cost is structural rather than in any one
hop. A trace of the open path found:

- The canvas controller awaited seven requests in series before the frame
  was given a URL: the directory, the focus, sometimes the directory again,
  the source (up to 2 MB), the last build, the UI URL, then the token. Source
  and build are the code view. The frame did not need them, and the full
  sequence re-ran every six seconds while a Turn was working.
- The UI URL and the token were two routes that each listed the User's whole
  directory and read the Applet Durable Object in full. Six Durable Object
  round trips to derive two values that come from one record.
- Inside the page: the bundle ran, the socket opened, the server said `hello`,
  the client said `hello`, the server sent `snapshot`, and only then did the
  first render happen. Two of those legs carry nothing the other end did not
  already know.
- The socket's first arrival at an evicted Applet Durable Object fetched the
  server bundle from R2, hashed all of it, loaded the isolate and ran the
  schema DDL, in that order, on the socket's critical path. The same fetch and
  hash ran again on every later mount in the same instance.
- The UI artifact route re-read R2 and re-hashed the HTML on every request,
  although it already served `immutable` under a content-addressed key, and
  the credentialless iframe and the phone WebView share none of the app
  origin's HTTP cache.
- Phones built the WebView on tap; the desktop tiers build the frame at Bot
  selection. A tap from the picker re-ran the whole controller load.
- The frame's identity included the viewer token, so the re-mint three
  minutes before the fifteen-minute expiry tore the document and its socket
  down about every twelve minutes.

The applet sandbox rules are not in question: no new subresources, the loader
keeps `globalOutbound: null`, the artifact origin keeps `default-src 'none'`,
and the HMAC viewer token stays the only credential the page holds.

## Decision

Seven changes, landed as four pull requests in the order below.

1. **One open endpoint.** `GET /api/bots/:bot/applets/open` answers
   `AppletOpenViewV1`: the directory, and for the focused Applet its
   `appletId`, `generationId`, `uiUrl`, `token`, `socketUrl` and `expiresAt`.
   The directory listing and the focus read run in parallel; the current
   generation is one `AppletState.open` RPC that reads the pointer and its
   generation record and nothing else; the token is minted locally. The two
   old routes stay for the chat card and any external caller, but they now
   read one directory entry rather than the whole listing, and share the same
   single-read helper.
2. **Source and build off the critical path.** The controller sets `viewer`
   from the open answer and notifies before it asks for anything else. Source
   and build are read afterwards, and only when the code view is what is on
   screen: while an Applet is unpublished (the building state, where the code
   is the content) or when the reader has chosen the Code tab. A running Turn
   polls the open endpoint alone; the read that finds the publish is the one
   at settle, as before.
3. **Snapshot in the server hello.** Wire protocol v2. A page that has no
   cursor connects with `v=2` on the socket URL and receives a `hello` that
   carries the snapshot, and it renders and marks its collections ready on
   that one frame. A reconnect carries `since` on the URL; the server then
   sends a plain `hello`, the client answers with its own `hello {since}`, and
   the `changes` path is unchanged. A page built before this change sends
   neither parameter and is spoken to in v1 exactly as before, so no published
   generation needs a rebuild. When the snapshot does not fit the 64 KB frame
   the hello goes without it and the v1 exchange follows.
4. **Warm the mount from the open endpoint.** `AppletState.open` starts the
   mount in the background (`ctx.waitUntil`) when the facet is not resident,
   so the isolate and the schema are ready before the socket arrives. The
   loaded worker stub is cached per Durable Object instance by loader id, so
   every socket and tool call after the first in an instance costs no R2 read
   and no hash. The per-mount SHA-256 over the whole bundle is replaced by the
   content-addressed key plus the R2 etag recorded at the activation that did
   verify the hash (see below).
5. **Edge cache the UI artifact.** `servePackageUiArtifact` consults the
   Workers Cache API before R2. The cache key is the request URL, which is the
   hash. A hit is served from the edge with the same `immutable`, `etag`,
   `no-transform` and CSP headers, and the 304 path is unchanged; a miss reads
   and verifies as before and populates the cache.
6. **Pre-mount the WebView on phones.** The single tier holds the live frame
   off stage from the moment the Bot is adopted, under a key the shell owns.
   Presenting the panel moves that widget into the pushed page rather than
   constructing another, and the picker posts focus and reads the open
   endpoint only.
7. **Rotate the token without rebuilding the frame.** The frame's identity is
   the generation and the UI URL. A re-minted token reaches the running page
   as an `init`-shaped `refresh` message; the transport reconnects in place,
   which with `since` on the URL is the `changes` path. On a phone the message
   goes through `runJavaScript`, as `init` already does. The controller
   re-reads the open endpoint three minutes before expiry, so a token is
   refreshed whether or not a Turn is running.

## Why the etag keeps "mismatched bytes never become code"

The guarantee is that the loader is only ever handed bytes whose SHA-256 is
the generation's `server.contentHash`. Today that is enforced by hashing on
every mount. After this change it is enforced by hashing once and pinning
what was hashed:

- The write path is unchanged: `putPackageArtifact` refuses bytes whose hash
  is not the key. The key is the hash, so two different byte strings cannot
  share a key.
- A publish or revert activates the generation through `#activate`, which
  still reads the artifact and verifies the full hash. That activation records
  the R2 object's `etag` in the durable mount input beside the hash.
- Every later mount of that input reads the object and compares its `etag`
  to the recorded one. R2's etag identifies one stored object version: an
  object rewritten under the same key, by anyone, has a different etag. A
  match therefore proves the bytes are the ones the activation hashed.
- A mismatch, or a mount input recorded before this change and so carrying no
  etag, falls back to the full hash and then records the etag. Nothing is
  refused that would have passed before, and nothing is loaded that was never
  hashed against its key.

Existing published generations keep opening: their mount input decodes with
the etag absent, the first mount after the deploy takes the hashing path once,
and the etag is written for the next.

## Consequences

- The client contract gains `AppletOpenViewV1`, declared in
  `core/contracts/applets.ts` and in the client wire schema, so the native
  decoder is generated rather than written.
- The applet wire protocol has two speakers' versions on the same server, told
  apart by the socket URL. The version field is what a decoder checks; the
  `contract` field is unchanged at 1 because the tables, tools and mutation
  rules are unchanged.
- `AppletMountInputV1` gains an optional `serverEtag`. This is the one
  optional field this work adds to a durable record, and it is optional
  because the constraint on this work is that deployed Bots keep opening.
- Timing per hop (open endpoint, artifact fetch, socket open, hello, snapshot,
  first render) is logged behind a debug flag on both the client and the page
  so the numbers in each pull request can be reproduced.
- Chat is untouched. None of this adds a tool call or a receipt to the
  transcript.
