# Dependency advisory triage — 2026-09-05

`bun audit` on the resolved workspace lockfile reported 24 advisories. This document records
what pulled each vulnerable package in, whether any production surface ships or executes it,
the verdict, and what was done.

## Result

|        | Advisories | Critical | High | Moderate |
| ------ | ---------- | -------- | ---- | -------- |
| Before | 24         | 1        | 13   | 10       |
| After  | 0          | 0        | 0    | 0        |

Resolved versions after the change: `tar@7.5.22`, `vite@8.2.2` (root) and `vite@7.3.6`
(desktop), `app-builder-lib@26.15.3`, `builder-util-runtime@9.7.0`, `element-plus@2.14.5`,
`file-type@21.3.4`, `uuid@11.1.1`. No vulnerable duplicate of any of these remains in the
tree. Package count fell from 1805 to 1602.

## Production surfaces considered

- **Cloudflare Worker bundle** (`apps/cloudflare`) — the deployed request handler and its
  client bundle. Everything below appears only in its `devDependencies`, or not at all.
- **Computer host runtime** (`packages/computer-host-runtime`) — runs on Sprites. It has no
  runtime dependencies at all; its only dependencies are `@types/bun`, `@types/node` and
  `typescript`. None of these advisories can reach it.
- **Android app** (`apps/mobile` plus its Capacitor Android project). The APK contains the
  Vite-built web assets and the Capacitor Android runtime. `@capacitor/cli` and everything
  under it is build-time tooling on the developer machine and is not packaged.
- **Published npm packages** — `@frockbot/applet-sdk` is the only workspace package that is
  not `private`. Its dependencies are TanStack DB, React, esbuild, eslint, miniflare and
  TypeScript; none of the advisory packages appear under it.

## Verdicts

| Package                        | Severity                            | Pulled in by                                                                                                                                                                                                                     | Ships or executes in production?                                                                                                                                                                                                                                                              | Verdict                                 | Action                                                                                                                                       |
| ------------------------------ | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `tar` < 7.5.7                  | 1 critical, 8 high, 3 moderate (12) | Three nested `tar@6.2.1` copies, all descended from a stale `electron-builder-squirrel-windows@26.0.12`: its `app-builder-lib@26.0.12`, `@electron/rebuild@3.7.0 › @electron/node-gyp`, and `cacache@16.1.3` under that node-gyp | No. Desktop packaging and native-module rebuild tooling only                                                                                                                                                                                                                                  | Fix now                                 | Declared `electron-builder-squirrel-windows@26.15.3` in `apps/desktop`; all three nested copies collapsed onto the safe hoisted `tar@7.5.22` |
| `vite` >= 7.1.0 <= 7.1.10      | 3 high, 3 moderate (6)              | One vulnerable copy: `apps/desktop` pinned `vite@7.1.10`. Every other workspace was already on `8.2.2`; `@cordisjs/client` resolves `7.3.6`, outside the range                                                                   | No. Build tool and dev server. The advisories require a reachable `vite dev` server; nothing is shipped                                                                                                                                                                                       | Fix now                                 | `apps/desktop` moved to `vite@7.3.6`                                                                                                         |
| `app-builder-lib` < 26.15.0    | 1 high                              | `electron-builder-squirrel-windows@26.0.12 › app-builder-lib@26.0.12`. The direct `electron-builder@26.15.3` already resolved the fixed `26.15.3`                                                                                | No. The advisory concerns Linux AppImage artifacts; `apps/desktop` does target AppImage, but the invoked copy was always the fixed `26.15.3`                                                                                                                                                  | Fix now                                 | Same squirrel bump; the stale copy is gone                                                                                                   |
| `builder-util-runtime` < 9.7.0 | 1 high                              | Same stale squirrel subtree (`app-builder-lib@26.0.12`, `builder-util@26.0.11`)                                                                                                                                                  | No. The credential leak is in `electron-updater`'s HTTP client, and the repo has no `electron-updater` dependency and no auto-update path                                                                                                                                                     | Fix now                                 | Same squirrel bump; resolved to `9.7.0`                                                                                                      |
| `uuid` < 11.1.1                | 1 moderate                          | `apps/mobile` devDependency `@capacitor/cli@8.5.0 › xcode@3.0.1 › uuid@7.0.3`                                                                                                                                                    | No. Build-time Xcode-project generation. Not in the APK, not in the Worker                                                                                                                                                                                                                    | Dev-only, but cheap to fix              | Root override to `^11.1.1`                                                                                                                   |
| `file-type` >= 13.0.0 < 21.3.1 | 2 moderate                          | `apps/cordis-poc › @cordisjs/plugin-webui@0.8.2 › @cordisjs/fetch-file@1.0.3` (`file-type ^20.4.1`)                                                                                                                              | No. Cordis proof-of-concept only                                                                                                                                                                                                                                                              | Not applicable to production, but fixed | Root override to `^21.3.1` (resolves `21.3.4`)                                                                                               |
| `element-plus` <= 2.11.0       | 1 moderate                          | `apps/cordis-poc › @cordisjs/client@0.8.2`                                                                                                                                                                                       | No. `@cordisjs/client` is also a dependency of `apps/desktop` and is imported by `packages/plugin-computer` client code, so this was checked directly: the built Worker client bundle under `apps/cloudflare/dist/client` contains no `element-plus` and no `el-link` — it is tree-shaken out | Not applicable to production, but fixed | Root override to `2.14.5` (same major)                                                                                                       |

## Changes made

`apps/desktop/package.json`

- `vite` `7.1.10` → `7.3.6`.
- Added `electron-builder-squirrel-windows: 26.15.3` to `devDependencies`. It is a required
  peer of `app-builder-lib` and was already being installed implicitly, but Bun would not
  apply an override to an implicitly installed peer, so the stale `26.0.12` subtree survived
  every reinstall. Declaring it explicitly is what removes the whole subtree. The desktop
  Windows target is `nsis`, so this package is never invoked; it exists only to satisfy the
  peer.

Root `package.json` — added `overrides`:

- `element-plus: 2.14.5`
- `file-type: ^21.3.1`
- `uuid: ^11.1.1`

Overrides were used for these three because the vulnerable versions come from unmaintained
intermediate packages (`@cordisjs/client`, `@cordisjs/fetch-file`, `xcode`) whose own ranges
cannot be satisfied any other way. No dead dependency needed removing: every advisory had a
compatible fixed release, so nothing was dropped to make the audit pass.

### Why these overrides are safe

- **`uuid`**: `xcode@3.0.1` does `require('uuid')` and calls only `uuid.v4()`. The advisory is
  a missing buffer bounds check in `v3`/`v5`/`v6` when the caller passes `buf`, which `xcode`
  never does. `uuid@11.x` still publishes a CommonJS `require` condition (14.x does not), so
  `^11.1.1` was chosen deliberately. Verified that `require('uuid')` from `xcode` resolves to
  `uuid@11.1.1`'s CJS build and that `v4()` works.
- **`file-type`**: `@cordisjs/fetch-file` uses exactly one export, `fileTypeFromStream`. It is
  present and behaves identically in `21.3.4`; verified against a real file for both
  `fileTypeFromStream` and `fileTypeFromBuffer`.
- **`element-plus`**: `2.7.7` → `2.14.5` is a minor bump inside the same major.

## Verification

All run after `bun install --force` on the final lockfile:

| Check                                                                                                                                                                                                        | Result                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `bun install --force`                                                                                                                                                                                        | 1602 packages, clean                                                                       |
| `bun run typecheck` (includes the client-protocol, kernel-import, computer-host-import, isolate-catalog and Applets-artifact checks)                                                                         | 82/82 packages pass                                                                        |
| `bun test`                                                                                                                                                                                                   | 4589 pass, 0 fail across 436 files                                                         |
| `bun run format:check`                                                                                                                                                                                       | clean                                                                                      |
| `bun run --filter @frockbot/cloudflare test:integration`                                                                                                                                                     | 50 files, 125 tests pass                                                                   |
| `bun scripts/check-client-protocol.ts`, `check-kernel-imports.ts`, `check-computer-host-imports.ts`, `check-ui-styles.ts`, `generate-isolate-context-catalog.ts --check`, `build-applets-package.ts --check` | all pass                                                                                   |
| `bun run build:cloudflare`                                                                                                                                                                                   | Worker dry-run deploy succeeds                                                             |
| `bun run build:webui` + `bun run --filter @frockbot/desktop build`                                                                                                                                           | Electron main/preload/renderer build on `vite@7.3.6`; bundle-boundary check passes         |
| `bun run --filter @frockbot/mobile build`                                                                                                                                                                    | passes                                                                                     |
| `bun run --filter @frockbot/mobile sync` (`cap sync`)                                                                                                                                                        | passes — exercises the `uuid` override through `@capacitor/cli`                            |
| `apps/mobile/android` `./gradlew assembleDebug`                                                                                                                                                              | `app-debug.apk` produced                                                                   |
| `bun run proof:cordis`                                                                                                                                                                                       | smoke passes — exercises the `file-type` and `element-plus` overrides via the Cordis webui |
| `bun audit`                                                                                                                                                                                                  | no vulnerabilities found                                                                   |

## Follow-ups not taken

- **`apps/desktop` on `vite@8`.** The rest of the repo is on `8.2.2`; desktop cannot follow
  because `electron-vite@5.0.0` (the latest release) declares
  `peerDependencies.vite: ^5.0.0 || ^6.0.0 || ^7.0.0`. `7.3.6` is the newest version that
  satisfies it and is outside the advisory range. Revisit when electron-vite adds Vite 8.
- **`@capacitor/*` 8.5.0 major upgrade.** Out of scope; a Capacitor major changes the Android
  and iOS project shapes.
- **Cloudflare `wrangler` / workers-sdk major.** Pinned to `latest`; not touched here.
- **Vue 3.5.41 major.** Not touched here.
- **Retire or vendor `apps/cordis-poc`.** It is the only reason `@cordisjs/client`,
  `@cordisjs/plugin-webui`, `element-plus` and `file-type` are in the lockfile. Deciding the
  proof-of-concept's future would remove the need for two of the three overrides rather than
  papering over them.
- **Override scope.** Bun's `overrides` are global to the workspace. If a workspace later
  needs an older major of `element-plus`, `file-type` or `uuid`, these pins must be narrowed
  or removed rather than worked around.
