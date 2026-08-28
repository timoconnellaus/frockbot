# Research: Cordis-first foundation for FrockBot

## Summary

Use the current public Cordis 4 release-candidate line, not the legacy `@cordisjs/core` / `@cordisjs/loader` / `@cordisjs/schema` line: pin `cordis@4.0.0-rc.8`, `@cordisjs/plugin-loader@1.0.0-rc.5`, `@cordisjs/plugin-server@1.7.0`, and the matched WebUI pair `@cordisjs/plugin-webui@0.8.2` + `@cordisjs/client@0.8.2`. This is suitable for a Bun-managed Electron application provided Bun is only the package manager/build tool and Electron's Node runtime executes Cordis; WebUI dev mode additionally requires an Electron/host Node version satisfying Vite 7's Node 20.19+ or 22.12+ floor.

The foundation is usable but not stable: core and loader are release candidates, WebUI is pre-1.0, the published WebUI package peers on Cordis `^4.0.0-rc.6`, and the standalone schema service belongs to the obsolete Cordis 3 package topology. Start behind small FrockBot-owned adapters and prove lifecycle, loader, HTTP/WebSocket, packaging, and renderer loading before building product APIs.

## Findings

### 1. Authoritative package identity and pins

The following matrix distinguishes current npm artifacts from old names that remain searchable.

| Concern                   | Current upstream package                                                           |                                          Recommended exact pin | Published peer/dependency facts                                                                                                                                                                  | Assessment                                                                                                                                                                                                                                                                             |
| ------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core runtime              | `cordis`                                                                           |                                                   `4.0.0-rc.8` | ESM-only (`type: module`, `lib/index.js`); dependencies `cosmokit ^1.8.1`, `@standard-schema/spec ^1.1.0`; optional peers loader `^1.0.0-rc.5` and include `^1.0.4`                              | **Use; medium risk (RC).** npm marks rc.8 as `latest`; published `gitHead` is `f46ae95e…`. [npm metadata](https://registry.npmjs.org/cordis/4.0.0-rc.8) [current manifest](https://github.com/cordiverse/cordis/blob/main/packages/core/package.json)                                  |
| Runtime loader            | `@cordisjs/plugin-loader`                                                          |                                                   `1.0.0-rc.5` | ESM-only; peer `cordis ^4.0.0-rc.7`; optional peer `node-addon-require-builtin ^0.1.0`; published `gitHead` `56b3d4f7…`                                                                          | **Use only where dynamic plugin trees are needed; medium risk (RC).** [npm metadata](https://registry.npmjs.org/@cordisjs%2fplugin-loader/1.0.0-rc.5) [source manifest](https://github.com/cordiverse/cordis/blob/main/packages/loader/package.json)                                   |
| Schema/config definitions | `schemastery` (directly used by WebUI); core also consumes `@standard-schema/spec` | `schemastery@3.18.0` only if FrockBot authors schemas directly | Current WebUI imports default `z` from `schemastery`; core has no `packages/schema` on `main` and exports only core modules                                                                      | **Do not install `@cordisjs/schema` in the Cordis 4 foundation.** [WebUI source](https://github.com/cordiverse/webui/blob/main/plugins/webui/src/index.ts) [core exports](https://github.com/cordiverse/cordis/blob/main/packages/core/src/index.ts)                                   |
| Legacy schema service     | `@cordisjs/schema`                                                                 |                                                           none | npm `latest` is `0.1.1`, published 2024, peer `@cordisjs/core ^3.16.1`; `next` is `1.0.0-alpha.0`                                                                                                | **High-risk/incompatible topology; omit.** It targets the old `@cordisjs/core` name, not `cordis@4`. [registry metadata](https://registry.npmjs.org/@cordisjs%2fschema) [original source commit](https://github.com/cordiverse/cordis/commit/ab63f5fb4b19160acdc57091fc3f30c6ad94ad55) |
| HTTP/WebSocket service    | `@cordisjs/plugin-server`                                                          |                                                        `1.7.0` | ESM-only; peer `cordis ^4.0.0-rc.6`; dependencies include `ws`, `accepts`, `schemastery`, and `path-to-regexp`                                                                                   | **Use in main host with WebUI.** [npm metadata](https://registry.npmjs.org/@cordisjs%2fplugin-server/1.7.0)                                                                                                                                                                            |
| WebUI server plugin       | `@cordisjs/plugin-webui`                                                           |                                                        `0.8.2` | exact peer `@cordisjs/client 0.8.2` (optional) and `cordis ^4.0.0-rc.6`; dev-tested with server `^1.6.2`, loader `^1.0.0-rc.4`, Vite `^7.3.2`                                                    | **Use matched with client 0.8.2; medium/high risk (pre-1.0 and moving source).** [npm metadata](https://registry.npmjs.org/@cordisjs%2fplugin-webui/0.8.2) [manifest](https://github.com/cordiverse/webui/blob/main/plugins/webui/package.json)                                        |
| WebUI/Vue client          | `@cordisjs/client`                                                                 |                                                        `0.8.2` | dependencies include `cordis ^4.0.0-rc.6`, Vue `^3.5.33`, Vite `^7.3.2`, plugin-vue `^6.0.6`, VueUse `^14.3.0`, UnoCSS `^66.6.8`; package root export is TypeScript source (`./client/index.ts`) | **Use in renderer/build context; exact-match with server plugin.** [npm metadata](https://registry.npmjs.org/@cordisjs%2fclient/0.8.2) [manifest](https://github.com/cordiverse/webui/blob/main/packages/client/package.json)                                                          |

**Important manifest nuance.** The Cordis repository `main` manifest has already moved core and loader peer declarations to rc.8, while the published loader rc.5 artifact records peer `cordis ^4.0.0-rc.7`. The reproducible application pin should therefore be the published pair `cordis@4.0.0-rc.8` + loader rc.5, while source audits should record both npm `gitHead`s rather than assuming repository `main` exactly equals the tarball. [core npm metadata](https://registry.npmjs.org/cordis/4.0.0-rc.8) [loader npm metadata](https://registry.npmjs.org/@cordisjs%2fplugin-loader/1.0.0-rc.5)

### 2. WebUI release-candidate, Vue, and Vite expectations

1. **WebUI 0.8.2 expects the Cordis 4 RC family, specifically a peer range beginning at rc.6.** Both `@cordisjs/plugin-webui@0.8.2` and `@cordisjs/client@0.8.2` declare `cordis ^4.0.0-rc.6`; server 1.7.0 does too. The exact recommended core rc.8 is the current npm `latest`, but a POC must run the package manager's peer-resolution check because prerelease semver behavior is easy to mishandle in custom tooling. [WebUI npm metadata](https://registry.npmjs.org/@cordisjs%2fplugin-webui/0.8.2) [client npm metadata](https://registry.npmjs.org/@cordisjs%2fclient/0.8.2) [server npm metadata](https://registry.npmjs.org/@cordisjs%2fplugin-server/1.7.0)
2. **The client pair is deliberately lockstep.** `plugin-webui` uses an exact `@cordisjs/client: 0.8.2` peer, not a caret. Do not independently float either side. [manifest](https://github.com/cordiverse/webui/blob/main/plugins/webui/package.json)
3. **The renderer stack is Vue 3 + Vite 7, not a generic embedded HTML console.** Client 0.8.2 depends on Vue `^3.5.33`, Vite `^7.3.2`, and `@vitejs/plugin-vue ^6.0.6`; its client source creates a Vue app and a browser-side Cordis `Context`. [client manifest](https://github.com/cordiverse/webui/blob/main/packages/client/package.json) [client bootstrap source](https://github.com/cordiverse/webui/blob/main/packages/client/client/index.ts)
4. **Vite 7 imposes a host runtime floor.** Official Vite documentation requires Node 20.19+ or 22.12+. This matters only when invoking WebUI dev/build tooling, but Electron's bundled Node—not Bun's version—governs code executed inside Electron. [Vite guide](https://vite.dev/guide/)
5. **Production mode does not require mounting a Vite dev server.** WebUI resolves its packaged `dist`, loads a manifest, serves immutable assets through `ctx.server`, and rewrites vendor imports; dev mode dynamically imports `createServer` from `@cordisjs/client/lib` and attaches Vite middleware at `/vite/`. [WebUI source](https://github.com/cordiverse/webui/blob/main/plugins/webui/src/index.ts)

### 3. Loader/client integration and process placement

- **Server-side service chain.** `@cordisjs/plugin-webui` uses `ctx.server` for HTTP routes and WebSockets and optionally reads `ctx.get('loader')` for entry paths/client-count behavior. Its source imports loader types but obtains the service dynamically, so loader is not a published runtime peer of WebUI; server is nevertheless a real runtime injection and must be mounted before WebUI. [WebUI node source](https://github.com/cordiverse/webui/blob/main/plugins/webui/src/index.ts) [WebUI base service](https://github.com/cordiverse/webui/blob/main/plugins/webui/src/base/index.ts)
- **Client-side Cordis is separate.** `@cordisjs/client` creates a fresh browser `Context`, installs `ClientService`, creates a Vue app, and receives `entry:init` plus mutations over the WebUI connection; renderer extensions are imported and mounted into client-side fibers. This is not the same context as the Electron main/agent context. [client bootstrap](https://github.com/cordiverse/webui/blob/main/packages/client/client/index.ts) [client loader](https://github.com/cordiverse/webui/blob/main/packages/client/client/plugins/loader.ts)
- **Loader responsibility.** Current loader supplies the `loader` service, imports plugin modules, tracks `Entry` ownership on fibers, unwraps ESM/default interop, and exposes location/environment data. It is appropriate at a process root that owns a dynamic plugin graph, not as a blanket renderer dependency. [loader source](https://github.com/cordiverse/cordis/blob/main/packages/loader/src/index.ts)
- **IPC boundary.** No primary Cordis/WebUI source establishes transparent cross-process Cordis contexts. FrockBot should treat main, utility, and renderer as three independent roots and bridge only explicit IPC/RPC DTOs. WebUI's own client/server bridge is HTTP/WebSocket, not Electron IPC. [WebUI base source](https://github.com/cordiverse/webui/blob/main/plugins/webui/src/base/index.ts) [Electron process model](https://www.electronjs.org/docs/latest/tutorial/process-model)

### 4. Minimal package sets by context

| Context                           | Minimal direct packages                                                                                        | Add only if needed                                                                                                                                                 | Do not put here                                                                                   | Rationale                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Electron main host**            | `cordis@4.0.0-rc.8`, `@cordisjs/plugin-server@1.7.0`, `@cordisjs/plugin-webui@0.8.2`, `@cordisjs/client@0.8.2` | `@cordisjs/plugin-loader@1.0.0-rc.5` if main owns configurable/dynamic host plugins; `node-addon-require-builtin` only if POC proves native-addon loading needs it | legacy `@cordisjs/core`, `@cordisjs/loader`, `@cordisjs/schema`; Vue as a main runtime dependency | WebUI requires server at runtime and exact client assets; Cordis/loader are ESM. [manifests](https://github.com/cordiverse/webui/blob/main/plugins/webui/package.json) [loader metadata](https://registry.npmjs.org/@cordisjs%2fplugin-loader/1.0.0-rc.5)                                                                                            |
| **Utility-process agent runtime** | `cordis@4.0.0-rc.8`                                                                                            | loader rc.5 if the agent graph is config/plugin driven; direct `schemastery@3.18.0` only when agent plugins author Cordis-style schemas                            | WebUI, client, Vue, Vite, server unless the agent itself intentionally exposes HTTP               | Electron utility processes run a Node.js environment and can load Node modules; keep the agent UI-free. [Electron utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process) [Electron process model](https://www.electronjs.org/docs/latest/tutorial/process-model)                                                                |
| **WebUI / Vue renderer-build**    | `@cordisjs/client@0.8.2`; pin `vue@3.5.33` and `vite@7.3.2` at the app level for reproducible builds           | `@vitejs/plugin-vue@6.0.6` for an app-owned Vite config; import browser/shared types from `@cordisjs/plugin-webui@0.8.2` when authoring extensions                 | server plugin and loader runtime                                                                  | Client already creates browser Cordis and Vue integration; package root ships TS source, so it must pass through Vite rather than be loaded as an untranspiled classic script. [client metadata](https://registry.npmjs.org/@cordisjs%2fclient/0.8.2) [client source](https://github.com/cordiverse/webui/blob/main/packages/client/client/index.ts) |

The main-host set includes `@cordisjs/client` because `plugin-webui` resolves the client's packaged app in dev mode and declares it as an exact optional peer; omitting it is only defensible for a deliberately static/custom shell whose production-assets POC demonstrates no resolution path. [WebUI source](https://github.com/cordiverse/webui/blob/main/plugins/webui/src/index.ts)

### 5. Bun-managed Electron compatibility

1. **Package management: compatible in principle.** Bun documents `bun install` as an npm-compatible package manager for existing `package.json`/`node_modules` projects. None of the selected package manifests declares a conflicting package-manager requirement. [Bun package manager](https://bun.com/package-manager)
2. **Runtime: use Electron/Node, not Bun, for Cordis hosts.** Electron main and utility processes are Node environments with Node APIs; Cordis loader source directly uses `process.env`, dynamic ESM imports, and Node module behavior. Electron documents ESM in main as using Node's ESM loader. [Electron process model](https://www.electronjs.org/docs/latest/tutorial/process-model) [Electron ESM](https://www.electronjs.org/docs/latest/tutorial/esm) [loader source](https://github.com/cordiverse/cordis/blob/main/packages/loader/src/index.ts)
3. **ESM packaging is mandatory.** Every recommended host package publishes `type: module` and `.js` ESM entry points. Main and utility entry files should therefore be ESM (`.mjs` or a `type: module` package), and Electron packaging must preserve package exports. [core npm metadata](https://registry.npmjs.org/cordis/4.0.0-rc.8) [server npm metadata](https://registry.npmjs.org/@cordisjs%2fplugin-server/1.7.0)
4. **Native/addon caveat.** Loader rc.5 exposes optional peer `node-addon-require-builtin`; no evidence says it is universally required. Do not add it preemptively, but test a packaged Electron build with any native plugin and confirm Bun's lock/install layout is preserved by the Electron packager. [loader npm metadata](https://registry.npmjs.org/@cordisjs%2fplugin-loader/1.0.0-rc.5)
5. **Renderer security remains Electron's responsibility.** WebUI expects browser networking and dynamically loaded renderer modules. Keep Node integration disabled and expose only a narrow preload bridge if FrockBot adds Electron IPC; Cordis/WebUI do not remove Electron's process boundary. [Electron process model](https://www.electronjs.org/docs/latest/tutorial/process-model)

### 6. Stability and maintenance warnings

- **Medium severity — prerelease API surface.** `cordis@4.0.0-rc.8` and loader rc.5 are explicitly release candidates. Loader history includes commits labeled “experimental write api,” and current loader source still contains `FIXME` comments around injection/config merging. Wrap plugin-tree mutation and lifecycle calls behind FrockBot-owned interfaces. [npm core metadata](https://registry.npmjs.org/cordis/4.0.0-rc.8) [experimental loader commit](https://github.com/cordiverse/cordis/commit/16ae5e5d108e96d82798a365d3a5381621cecfce) [loader source](https://github.com/cordiverse/cordis/blob/main/packages/loader/src/index.ts)
- **High severity — old schema package trap.** `@cordisjs/schema@0.1.1` peers on `@cordisjs/core ^3.16.1` and is absent from the current monorepo layout. Installing it alongside Cordis 4 risks duplicate/incompatible context types and services. [schema registry](https://registry.npmjs.org/@cordisjs%2fschema) [current core manifest](https://github.com/cordiverse/cordis/blob/main/packages/core/package.json)
- **Medium severity — WebUI moving independently.** Published WebUI/client artifacts have `gitHead 591b4ffa…`, while current repository `main` is `2a884b56…`; source `main` may contain unreleased behavior. Validate against tarballs/pins, not screenshots or `main` alone. [WebUI npm metadata](https://registry.npmjs.org/@cordisjs%2fplugin-webui/0.8.2) [repository main commit](https://github.com/cordiverse/webui/commit/2a884b56e589d81c41e510922e6b9f12badef26a)
- **Medium severity — current upstream issue.** Cordis issue #72 reports that `ctx.isolate()` cleanup can over-clean parent registrations and lacks a scoped disposer. Avoid using bare isolated contexts as crash/unmount boundaries until reproduced/fixed; use plugin/fiber ownership and regression-test unload. [official issue](https://github.com/cordiverse/cordis/issues/72)
- **Low/medium severity — version range drift.** WebUI 0.8.2 was developed with loader rc.4 and server 1.6.2 but peers only on Cordis/client; recommended loader rc.5 and server 1.7.0 are newer compatible-family releases, so an integration test is required rather than assuming devDependency equality. [WebUI npm metadata](https://registry.npmjs.org/@cordisjs%2fplugin-webui/0.8.2)

### 7. Stock upstream versus DeepSeek Harness vendoring

Do **not** use DeepSeek Harness's packages as a drop-in Cordis distribution for FrockBot. DSH rescopes the packages (`cordis` → `@deepseek-ai/cordis`, loader → `@deepseek-ai/cordis-plugin-loader`), marks them private workspaces, and pins core 4.0.0-rc.7 + loader rc.5 to upstream commit `56b3d4f7…`. [DSH vendor manifest](https://github.com/deepseek-ai/deepseek-harness/blob/master/vendor/README.md) [DSH rescope docs](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/rescope.md)

Material, primary-source-established differences are larger than renaming: DSH records local lifecycle hardening in `cordis/src/fiber.ts`, transactional loader/include reconciliation, HMR watcher changes, TypeScript specifier/build changes, and extracted include patch semantics. Those changes explain why DSH behavior/tests cannot be used as proof that stock rc.8 has the same guarantees. Conversely, FrockBot should not inherit a large private fork merely to obtain those fixes; reproduce the relevant lifecycle/config tests against stock upstream and upstream or locally isolate only demonstrated defects. [DSH local-modification log](https://github.com/deepseek-ai/deepseek-harness/blob/master/vendor/README.md)

## Recommended exact pins

```json
{
  "dependencies": {
    "cordis": "4.0.0-rc.8",
    "@cordisjs/plugin-loader": "1.0.0-rc.5",
    "@cordisjs/plugin-server": "1.7.0",
    "@cordisjs/plugin-webui": "0.8.2",
    "@cordisjs/client": "0.8.2"
  },
  "devDependencies": {
    "vue": "3.5.33",
    "vite": "7.3.2",
    "@vitejs/plugin-vue": "6.0.6"
  }
}
```

Split these into workspace/package contexts according to the minimal-package matrix rather than installing all packages into every process. Do not add `@cordisjs/schema`; add exact `schemastery@3.18.0` only to packages that directly import it. Commit `bun.lock`, and retain npm integrity/provenance through normal registry resolution. [package manifests](https://github.com/cordiverse/webui/blob/main/packages/client/package.json)

## Initial proof-of-concept checks

Run these before product-layer development; each should be automated and repeated against a packaged Electron artifact.

1. **Install/peer proof:** in a clean workspace run `bun install --frozen-lockfile` after the initial lock is created; fail on peer warnings and verify one resolved copy of `cordis`, client 0.8.2, WebUI 0.8.2, loader rc.5, and server 1.7.0.
2. **Main lifecycle proof:** ESM Electron main creates `new Context()`, mounts server then WebUI, waits for readiness, opens its local URL, then disposes and confirms HTTP listener/WebSocket closure.
3. **Utility lifecycle proof:** spawn `utilityProcess`, import `cordis`, mount a test plugin, exchange a structured-clone message, dispose it, and exit cleanly. Repeat plugin load/unload 100 times and assert no listener/timer growth.
4. **Loader proof:** mount loader rc.5, dynamically import a tiny ESM plugin, update config, remove it, await outstanding tasks, and verify exactly-once effects/cleanup. Include a failing import and failing async cleanup.
5. **Isolation regression:** reproduce or exclude Cordis issue #72; assert unloading an agent/plugin cannot remove parent host listeners. Treat failure as a launch blocker for any design that uses `ctx.isolate()` as the process/plugin boundary.
6. **WebUI production proof:** `devMode: false`; load packaged assets and extension JS/CSS from an asar/unpacked Electron build, establish WebSocket, receive `entry:init`, invoke one RPC, reconnect, and verify version mismatch reload behavior.
7. **WebUI development proof:** `devMode: true`; confirm Electron's embedded Node satisfies Vite 7, `/vite/` middleware works, HMR updates one extension, and shutdown closes Vite.
8. **Renderer proof:** with `nodeIntegration: false` and context isolation enabled, mount `@cordisjs/client`, navigate a Vue route, load an extension, and confirm no Node global is required in renderer code.
9. **Bun/Electron packaging proof:** install with Bun, package for all target OS/architectures, launch without Bun installed, and test dynamic import/package exports. If a native plugin is planned, exercise it before deciding whether `node-addon-require-builtin` is needed.
10. **Pin provenance check:** record package versions, integrity hashes, and npm `gitHead`s in generated build metadata so an upstream `main` audit cannot be confused with the shipped tarballs.

## Local foundation proof

The repository now contains an executable proof at `apps/cordis-poc`. On Electron 44.0.0 with embedded Node 24.18.1 it verifies:

- 100 repeated Cordis plugin mounts with exactly-once setup and cleanup;
- dependency-driven pending, activation, unload, and reactivation;
- isolated child disposal without removing a parent event listener;
- loader creation, configuration restart, removal, and contained missing imports;
- a Cordis root inside an Electron utility process with typed-message round trip and graceful disposal;
- the custom Cordis agent runtime streaming a plain turn, executing a journaled tool call, repeating the model step, recovering after a hard utility-process kill, and shutting down cleanly through the production protocol;
- Cordis server and WebUI 0.8.2 production assets in a sandboxed Electron renderer;
- a live WebUI WebSocket connection with Node globals unavailable;
- cookie admission, arbitrary-origin rejection, CSP delivery, loopback-only binding, and listener shutdown.

The proof also exposed two loader/interface requirements now captured in the architecture: loader rc.5 can resolve a write after logging a failed import without mounting a fiber, and plugin function declarations may be treated as constructors. FrockBot therefore verifies and awaits the exact entry fiber and authors factories as arrow functions or explicit `{ apply }` objects.

Run the complete proof with `bun run proof:cordis`.

## Sources

### Kept

- [Cordis current core manifest](https://github.com/cordiverse/cordis/blob/main/packages/core/package.json) — official current package identity and dependency topology.
- [Cordis core npm metadata, rc.8](https://registry.npmjs.org/cordis/4.0.0-rc.8) — exact published artifact, integrity, peers, and `gitHead`.
- [Cordis loader manifest](https://github.com/cordiverse/cordis/blob/main/packages/loader/package.json) and [loader npm metadata](https://registry.npmjs.org/@cordisjs%2fplugin-loader/1.0.0-rc.5) — exact loader identity/version and runtime peers.
- [Legacy schema npm metadata](https://registry.npmjs.org/@cordisjs%2fschema) — establishes old peer topology and publication age.
- [WebUI plugin manifest](https://github.com/cordiverse/webui/blob/main/plugins/webui/package.json), [client manifest](https://github.com/cordiverse/webui/blob/main/packages/client/package.json), and their exact npm version endpoints — lockstep versions and Vue/Vite/Cordis ranges.
- [WebUI node source](https://github.com/cordiverse/webui/blob/main/plugins/webui/src/index.ts), [base source](https://github.com/cordiverse/webui/blob/main/plugins/webui/src/base/index.ts), and [client source](https://github.com/cordiverse/webui/blob/main/packages/client/client/index.ts) — first-party integration behavior.
- [Server 1.7.0 npm metadata](https://registry.npmjs.org/@cordisjs%2fplugin-server/1.7.0) — exact server peer/dependency information.
- [Electron process model](https://www.electronjs.org/docs/latest/tutorial/process-model), [utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process), and [ESM guide](https://www.electronjs.org/docs/latest/tutorial/esm) — authoritative execution model.
- [Bun package manager docs](https://bun.com/package-manager) and [Vite guide](https://vite.dev/guide/) — authoritative package-manager and Node-floor facts.
- [DSH vendor manifest](https://github.com/deepseek-ai/deepseek-harness/blob/master/vendor/README.md) — exact first-party fork pins and modification log.

### Dropped

- DepScope, npmx, npm.io, and other npm mirrors — redundant/non-primary; registry JSON was used instead.
- Search-result summaries and historical commentary — used only to locate official manifests/source, not as evidence.
- DeepSeek Harness tutorials/marketing pages — vendor manifest and rescope documentation provide the material fork facts directly.
- Third-party Bun/Electron compatibility posts — official Bun, Electron, and Vite documentation is sufficient.

## Gaps

- No primary source claims that the exact six-package combination has been tested inside Electron or installed by Bun; compatibility is inferred from ESM/package manifests and Electron's Node execution model. The POC matrix is therefore required.
- No first-party FrockBot repository execution was performed in this research-only run, so asar behavior, Electron's actual embedded Node version, Bun lockfile peer resolution, CSP, and target-platform native modules remain unverified.
- npm package metadata establishes tarball `gitHead`s, but source `main` has moved after some publications; behavior-level claims must be validated against installed tarballs.

## Acceptance evidence

- **Finding (high):** legacy `@cordisjs/schema` targets `@cordisjs/core ^3.16.1` and must not be added to the Cordis 4 foundation.
- **Finding (medium):** WebUI/client must be exact-paired at 0.8.2 and require the Cordis rc.6-compatible family.
- **Finding (medium):** Vite 7 dev mode requires Node 20.19+ or 22.12+, to be checked against the selected Electron release.
- **Finding (medium):** DSH is a materially modified, rescoped vendor fork and is not behavioral evidence for stock Cordis.
- **Artifact path:** `subagent-artifacts/outputs/5dba5ee9-eed0-4637-8bda-353162e81f2b/research.md`.
