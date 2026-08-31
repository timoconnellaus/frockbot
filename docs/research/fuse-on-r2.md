# FUSE mount of R2 inside a Cloudflare Container (`fuse-on-r2`)

## Status

Code read 2026-08-31, read-only. Answers the ADR 0013 question of whether a FUSE mount of R2 on a
per-User Computer is a portable recipe, and what it does **not** give us.

Sources read (whole repo, `node_modules` excluded):

- `/Users/tim/repos/fuse-on-r2` — `Dockerfile`, `container_src/startup.sh`, `container_src/main.go`,
  `src/index.ts`, `wrangler.jsonc`, `git log`. Apache-2.0, Cloudflare-authored demo
  (`README.md:1-3`, `LICENSE`).
- `/Users/tim/repos/cf-computer` — checked and **eliminated**: `grep -rniE
'tigrisfs|rclone|geesefs|s3fs|mountpoint-s3|dev/fuse|SYS_ADMIN'` over the repo (excluding
  `node_modules`) returns nothing. It uses Fly Sprites as its sandbox substrate (`README.md:31-33`),
  not a FUSE mount.
- `/Users/tim/repos/sandboxed` — eliminated: an Apple-container codex harness with an egress proxy
  (`Dockerfile:1-9`, `entrypoint.sh:1-30`). No storage mount at all.

So `fuse-on-r2` is the only working mount here, and it is a **four-file demo**: a Worker, a Go
`ReadDir` handler, a Dockerfile, and a 31-line startup script. Everything below that reads as an
absence really is one. Richer production prior art is zerobsai, written up in
[`zerobsai-memory-sandbox.md`](./zerobsai-memory-sandbox.md); cited here where the two diverge.

## 1. FUSE implementation and mount command

**tigrisfs**, pinned by build arg, downloaded as a release tarball — not a package.

```dockerfile
ARG TIGRISFS_VERSION=v1.2.1                                   # Dockerfile:3
RUN apk add --no-cache ca-certificates fuse fuse-dev curl bash # Dockerfile:20
```

(`Dockerfile:22-29`; arch is mapped `x86_64→amd64`, `aarch64→arm64`.)

The mount itself, in full (`container_src/startup.sh:4-11`):

```sh
MOUNT_DIR="$HOME/mnt/r2/${BUCKET_NAME}"
mkdir -p "${MOUNT_DIR}"
R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
/usr/local/bin/tigrisfs --endpoint "${R2_ENDPOINT}" -f "${BUCKET_NAME}" \
  "${MOUNT_DIR}${BUCKET_PREFIX:+:${BUCKET_PREFIX}}" &
```

Points that matter:

- **Three options total**: `--endpoint`, `-f` (foreground), and the positional
  `<bucket> <mountpoint>`. The prefix is expressed by appending `:${BUCKET_PREFIX}` to the
  _mountpoint_ argument, guarded by `${VAR:+…}` so an empty prefix mounts the bucket root
  (`startup.sh:10`, `wrangler.jsonc:23-24`).
- **No cache settings, no consistency or refresh flags, no `-o` options anywhere.** Every caching,
  metadata-TTL, and write-back behaviour is whatever tigrisfs v1.2.1 defaults to. In particular
  there is no `--stat-cache-ttl`, no `--type-cache-ttl`, no `-o allow_other`. zerobsai's production
  mount _does_ pass `-o allow_other` because it drops to a non-root uid after mounting
  (`zerobsai-memory-sandbox.md:61-66`); this demo runs everything as root, so it does not need it.
- **Write-through vs write-back is not decided by this repo.** Nothing sets it and the demo never
  writes — `main.go` only calls `os.ReadDir` (`container_src/main.go:49`). tigrisfs's default
  (geesefs-lineage write-back, flushed on close) is **unverified from this code** and must be
  measured before FrockBot relies on it.
- The mount is a long-lived userspace process owning the mountpoint for the container's life, not
  `mount(8)`/`fstab`.

## 2. How R2 credentials reach the container

A **long-lived R2 S3-API key pair**, passed as plain environment variables. No temporary
credentials, no scoping, no rotation.

```ts
export class FUSEDemo extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "10m";
  envVars = {
    AWS_ACCESS_KEY_ID: this.env.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: this.env.AWS_SECRET_ACCESS_KEY,
    BUCKET_NAME: this.env.R2_BUCKET_NAME,
    BUCKET_PREFIX: this.env.R2_BUCKET_PREFIX,
    R2_ACCOUNT_ID: this.env.R2_ACCOUNT_ID,
  };
}
```

(`src/index.ts:13-23`.)

- **Kind**: R2 S3 API access key id + secret (`README.md:22`). Not an account API token, not R2's
  temp-access API.
- **Delivery**: Wrangler secrets → Worker `Env` → container `envVars` → process environment, where
  tigrisfs picks them up implicitly as AWS SDK variables. `startup.sh` never names them; it only
  builds the endpoint from `R2_ACCOUNT_ID` (`startup.sh:7`). No file, no `~/.aws/credentials`.
- **Scoping**: bucket is `R2_BUCKET_NAME`, prefix optionally `R2_BUCKET_PREFIX`, both declared as
  non-secret vars (`wrangler.jsonc:18-26`). But **the prefix is a client-side mount argument, not a
  credential scope** — the token itself is whatever the operator minted, and the container process
  can trivially re-run tigrisfs against the bucket root. Prefix is ergonomics, not isolation.
- **TTL / rotation**: none. The secret is set once by `wrangler secret put` (`README.md:23`) and
  lives for the container's life; there is no refresh loop, no expiry handling, and no code path
  that re-mounts on credential error.
- **Per-tenant scoping does not exist here.** One key pair per deployment, one bucket for all
  container instances. That is the single biggest gap between this demo and a per-User Sprite.

## 3. Where it runs, and what the host provides

- Cloudflare **Containers** (the `@cloudflare/containers` `Container` class over a Durable Object),
  not the Sandbox SDK: `wrangler.jsonc:27-47` declares `containers[].class_name: "FUSEDemo"`,
  `image: "./Dockerfile"`, `max_instances: 10`, and a `new_sqlite_classes` migration. The Worker
  routes with `getContainer(c.env.FUSEDemo)` and forwards the raw request
  (`src/index.ts:29-37`).
- **Base image**: `alpine:3.21`, from a `golang:1.24-alpine` build stage (`Dockerfile:5,16`).
  `fuse` and `fuse-dev` are installed (`Dockerfile:20`).
- **Privileged / device requirements**: **nothing is requested anywhere in this repo.** No
  `/dev/fuse` device, no `--cap-add SYS_ADMIN`, no `privileged`, no `security_opt`. Cloudflare's
  container runtime grants `CAP_SYS_ADMIN` and `/dev/fuse` implicitly in production — corroborated
  independently by zerobsai, where `wrangler dev` locally does _not_, so `/dev/fuse` fails to open
  and the mount silently degrades to tmpfs unless a Docker-socket MITM splices the capability and
  device into `POST /containers/create` (`zerobsai-memory-sandbox.md:90-97`). This demo has no such
  workaround and therefore cannot mount under `wrangler dev`.
- **Sandbox-specific vs portable**: the tigrisfs invocation, the endpoint URL shape, the prefix
  syntax and the readiness probe are all plain Linux and transfer unchanged. The container binding,
  `envVars` plumbing, `sleepAfter`, `max_instances`, and the implicit FUSE privileges are
  Cloudflare-specific.
- **What a Fly Sprite needs instead**: a Sprite is a microVM with a persistent ext4 filesystem and
  no user-configurable host privileges ([`fly-sprites-computer.md`](./fly-sprites-computer.md)).
  The open question is whether the Sprite's base image ships `/dev/fuse` and lets an unprivileged
  process open it — **not answered by any code in these repos, and it must be probed on a real
  Sprite before designing around it** (`cat /dev/fuse; modprobe fuse; tigrisfs --version`). If FUSE
  is unavailable, the whole recipe collapses to the sync-agent option. If it is available, the
  Sprite replaces the Dockerfile with a provisioning step (install the tigrisfs binary into
  `/home/sprite/.local/bin`, then checkpoint) and replaces `CMD` with a Sprites **service**
  definition, because only services are restarted after a cold pause.

## 4. Lifecycle

- **When**: at container boot, as PID 1's replacement. `CMD ["/startup.sh"]` (`Dockerfile:38`);
  tigrisfs is backgrounded, then the app is `exec`'d over the shell (`startup.sh:9-11,31`). Mount
  first, app second — the app is never started against an unmounted directory.
- **Readiness probe with fail-fast** (`startup.sh:13-28`): poll `mountpoint -q` for up to 30
  seconds, aborting early if the tigrisfs PID has already exited:

  ```sh
  until mountpoint -q "${MOUNT_DIR}" || [ "$i" -ge 30 ]; do
    if ! kill -0 "${TIGRISFS_PID}" 2>/dev/null; then
      echo "Error: tigrisfs exited unexpectedly before mount was ready" >&2
      exit 1
    fi
  ```

  This replaced a bare `sleep 3` — see the history below. It is the single most valuable line of
  this repo.

- **Restart / pause**: `sleepAfter = "10m"` (`src/index.ts:15`) stops the instance; the next request
  starts a fresh container that re-runs `startup.sh` and re-mounts. No persistent local disk, so
  nothing to reconcile — the mount is the only state.
- **Unmount / flush**: **not handled at all.** `main.go:94-124` installs a SIGINT/SIGTERM handler
  that gracefully shuts down the HTTP server with a 5-second timeout, and then exits — it never
  signals tigrisfs, never calls `fusermount -u`, and never waits for a flush. Because the shell
  `exec`s the server, tigrisfs is an orphaned child of PID 1 and dies with the container. Any dirty
  write-back page at that moment is lost. For a read-only demo this is invisible; for FrockBot it is
  a data-loss bug that has to be fixed explicitly.
- **Failure modes visible in history** (`git log --oneline`, 10 commits total):
  - `26f834a` "improve Dockerfile caching + tigrisfs script" — moved the startup script out of a
    `printf`-escaped `RUN` heredoc into a real file, and pinned `TIGRISFS_VERSION` instead of
    resolving "latest" from the GitHub API at build time. Unpinned-latest was a reproducibility
    hazard; the escaped heredoc was unmaintainable.
  - `519b263` "Fix bugs, update deps, improve error handling" (an automated-agent PR) — replaced
    `sleep 3` with the readiness loop, fixed a live bug where the script read `$PREFIX` while the
    Worker set `BUCKET_PREFIX` (so prefix mounts silently ignored the setting), bumped
    `alpine:3.20→3.21`, and wrapped the Worker's `container.fetch` in try/catch returning 502
    (`src/index.ts:33-36`).
  - No commit ever addresses unmount, writes, credential expiry, or concurrency.
- **Not surfaced to the app**: this demo only fails the boot. zerobsai instead writes `mounted` /
  `no-r2-creds` / `mount-failed` to `/var/run/zerobsai/fuse-status` so the agent can read that
  persistence is off (`zerobsai-memory-sandbox.md:99-104`); prefer that.

## 5. Write semantics

There are none to report, and that is the finding. `main.go` is a read-only `os.ReadDir` handler
capped at 10 entries (`container_src/main.go:49-72`). Concretely, across the whole repo:

- **Concurrent writers**: no coordination. Up to 10 instances (`wrangler.jsonc:31`) would mount the
  same bucket with the same credentials at the same paths, with nothing arbitrating.
- **ETag / `If-Match`**: absent. `grep` finds no ETag, conditional-header, or precondition logic
  anywhere. Whatever tigrisfs does on `PutObject` is unconditional as far as this code knows —
  **last-writer-wins**.
- **Writer attribution, generation ids, hash sidecars**: absent. There is no metadata layer of any
  kind. (Sidecars are zerobsai's pattern — `${ns}/meta/${path}.json` = `{ hashes, vectorIds }` —
  and they live on the R2 side, not the FUSE side, `zerobsai-memory-sandbox.md:20-27`.)
- **Delete propagation**: never exercised, and there is no out-of-band change notification — no R2
  event notification, queue, or cache-invalidation hook. An external change is seen only when
  tigrisfs's (unconfigured) metadata cache expires.
- **Large files / bundlers / installers**: no comments, no exclusions, no tests — the repo has no
  test framework at all (`AGENTS.md:6`). The README's only nod is a hedge: object storage "is not
  exactly a POSIX compatible filesystem, nor is it local, and so you should not expect native,
  SSD-like performance", suitable for "reading a bunch of shared assets, bootstrapping a
  agent/sandbox, or providing a way to persist user-state" and "rarely I/O intensive"
  (`README.md:11`). The hard evidence is zerobsai's, where both bundlers deliberately copy _out_ of
  the mount before building — `bun install` into a container-local temp dir, and an rsync of
  `/workspace/apps/<slug>` into `/var/cache/vibe/<slug>` (`zerobsai-memory-sandbox.md:105-110`).

## 6. Performance notes

No measurement of any kind exists in this repo: no benchmarks, no timings, no latency comments, no
caching decisions (because no cache is configured). The only performance statement is the README
hedge quoted above. Observability is Worker tracing at a 10% head sampling rate
(`wrangler.jsonc:11-17`), which measures the Worker→container hop, not the mount.

## 7. Other things that matter for the FrockBot decision

- **The demo answers "can it mount", not "can it be a filesystem for an agent."** Read-only listing
  of ten entries is the whole proven surface.
- **The credential story is the weakest part for us.** A long-lived, un-scoped, un-rotating R2 key
  pair sits in the container environment (`src/index.ts:17-18`). On a per-User Sprite it is readable
  by any process the User's Bots start (`/proc/<pid>/environ`, a shell, an npm postinstall). A FUSE
  mount inherently needs the credential _on the machine_; a backend sync agent does not.
- **A FUSE mount cannot satisfy ADR 0013's write contract on its own.** ADR 0013 requires that every
  write produce a generation, that writes be segregated by writer, and that a write overwriting an
  unseen generation be preserved as a conflict — "last-writer-wins is prohibited"
  (`docs/adr/0013-bidirectional-memory-sync.md`, Consequences). tigrisfs issues plain `PutObject`;
  there is no hook where `If-Match`, an `expectedGenerationId`, or a `.conflict/<generationId>`
  fallback could be injected. A mount would have to be paired with something else that owns the
  conditional write — at which point the mount is a convenience layer, not the write path.
- **Writer attribution is structurally unavailable through a mount.** A `write(2)` carries no
  identity; the object lands with whatever the single mount credential is. Attribution can only come
  from _prefix segregation_ (zerobsai's approach, and ADR 0013's `by-agent/<botId>/` sharding) or
  from a sync agent that stamps each upload.
- **Silent degradation is the dangerous failure.** zerobsai's tmpfs fallback under `wrangler dev` is
  the canonical example: everything works, nothing persists. Whatever we build must expose mount
  health as a value the Agent can read.

## Applicability to FrockBot

**Transfers directly**: the tigrisfs binary choice and pinned-release install (`Dockerfile:3,22-29`);
the endpoint URL shape `https://<account>.r2.cloudflarestorage.com` (`startup.sh:7`); the
`<mountpoint>:<prefix>` argument syntax for mounting a sub-prefix (`startup.sh:10`); and above all
the mount-readiness loop with PID fail-fast (`startup.sh:13-28`), which is the one hard-won piece of
engineering in the repo.

**Cloudflare-specific**: the `Container`/Durable Object binding and `envVars` plumbing
(`src/index.ts:13-23`, `wrangler.jsonc:27-47`); `sleepAfter`-driven container recycling as the
lifecycle model; and the implicit grant of `CAP_SYS_ADMIN` + `/dev/fuse` by the container runtime —
the assumption that lets this repo omit every privilege declaration, and exactly the assumption a
Sprite may not honour.

**Mount recipe I would use on a Fly Sprite** (contingent on the unresolved `/dev/fuse` probe in §3):

1. Probe FUSE availability on a real Sprite first. If `/dev/fuse` cannot be opened unprivileged, the
   FUSE option is dead and the sync agent wins by default.
2. Install the pinned tigrisfs release into `/home/sprite/.local/bin` during provisioning, then take
   a checkpoint — checkpoints capture the writable overlay and are incremental.
3. Define the mount as a Sprites **service** (`PUT /v1/sprites/{name}/services/r2-mount`), not a
   manual background process, so it restarts after a cold pause; give the workspace service
   `needs: ["r2-mount"]`. Keep the readiness loop in the consumer anyway — `needs` orders starts, it
   does not prove a mountpoint.
4. Mount **one prefix per User**, `bucket:users/<userId>`, at a fixed path such as
   `/home/sprite/agent-data/r2`. Never mount the bucket root.
5. Scope credentials per User and make them expiring. This is the part with no prior art in either
   repo and it is required work, not a port: mint a short-lived, prefix-scoped R2 credential from
   the backend and hand it to the Sprite, with a refresh path that re-mounts before expiry. The
   demo's single shared key pair is not acceptable per-User.
6. Handle unmount explicitly on the way down — the demo does not, and a write-back cache makes that
   a silent-loss bug. Flush and `fusermount -u` before any deliberate stop.
7. Keep build-shaped I/O off the mount (`node_modules`, bundlers, installers), on zerobsai's
   evidence; copy out to Sprite-local disk and build there.
8. Expose mount health as a readable value (zerobsai's `fuse-status` file), so the Agent knows when
   durability is off.

**My reading of the decision**: this demo is a strong existence proof that R2-as-a-filesystem works,
and no evidence at all that it can carry ADR 0013's write semantics. The mount is a good **read**
path and a good ergonomic surface for a User's own files; the conditional, attributed, conflict-
preserving **write** path has to live in a backend-owned component regardless. If both are needed,
the honest shape is a sync agent that owns writes, with a FUSE mount at most as a read-mostly
convenience — not a mount as the write path with a sync agent bolted on.
