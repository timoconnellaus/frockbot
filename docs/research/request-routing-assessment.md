# Request routing and startup

Source inspection at `4a1bdd9ea7b0c74e60cfced0ae6e4d7fd98b8a8a`, after the requested rebase on 2026-09-22. No runtime changes, model calls or latency measurements. These are recommendations for discussion, not additional agreed implementation decisions.

## Findings

Ordinary app REST requests still pass through a per-User loaded application Worker. Its code is our first-party application router, and every User currently receives the same deployment-selected build. This is separate from the Dynamic Workers that isolate Plugins and Applets. Compiling this router into the gateway is a concrete simplification worth discussing; it removes an application-loading dependency without changing Bot authority.

Authentication and Bot routing also repeat some reads. The opportunity is to reuse fresh, request-scoped identity and selected-Bot information, while retaining the checks that make session revocation, account suspension and Bot lifecycle changes effective.

## Current paths

```text
Native app REST request
  → verify bearer/client compatibility
  → read native session/revocation state from User DO
  → resolve current identity and account admission
  → read identity profile again
  → gateway reuses admission
  → loaded first-party application Worker, keyed by User + build hash
  → selected Bot membership, then full lifecycle directory
  → Bot DO reads selected Bot registration
  → Bot admission/execution

Voice socket
  → same gateway authentication/admission
  → voice Agent directly (bypasses loaded application Worker)

Bot observer socket
  → gateway authentication/admission and Bot ownership
  → Bot DO directly (bypasses loaded application Worker)
```

Browser sessions use their own session lookup rather than the native bearer path. Public/development/admin routes have deliberate exceptions; the diagram describes an ordinary authenticated native request. Sources: [gateway authentication](../../apps/cloudflare/src/gateway.ts#L681), [native authentication](../../apps/cloudflare/src/native-auth.ts#L394), [voice upgrade](../../apps/cloudflare/src/gateway.ts#L785), [observer upgrade](../../apps/cloudflare/src/index.ts#L2047).

## First-party application loading

`routeUserApplication` resolves an application hash, obtains a loaded Worker keyed by `userId:applicationHash`, and forwards the request to it. On a code-cache miss the loader callback reads `applications/<hash>.mjs` from R2. The loaded code receives a User-scoped `BOT_STATE` capability and deployment identity. Current production wiring selects `DEFAULT_APPLICATION_HASH` for every User. Sources: [route](../../apps/cloudflare/src/gateway.ts#L503), [artifact source](../../apps/cloudflare/src/index.ts#L1664), [build selection and scoped binding](../../apps/cloudflare/src/index.ts#L2749), [first-party router](../../apps/cloudflare/src/user-application.ts#L390).

This is **not an R2 read on every request**. Worker Loader caches by ID opportunistically; its callback is needed when both a new isolate and uncached code are required. A loaded Worker call is also not necessarily a remote network hop. The source establishes an extra lifecycle and possible cold dependency, not its elapsed cost. [Cloudflare Worker Loader API](https://developers.cloudflare.com/dynamic-workers/api-reference/).

The existing layer provides a restricted User capability boundary and content-addressed application artifacts. It also associates client assets and responses with an application version. It does not currently select different builds for different Users. Any removal must preserve the trusted User binding, request-size/error/body handling, public routes, compiled Flutter asset identity, deployment response header and client-update behavior. Sources: [forwarding and response version](../../apps/cloudflare/src/gateway.ts#L541), [application entry](../../apps/cloudflare/src/user-application.ts#L390).

**Recommendation:** compile ordinary application routing into the gateway, passing a fresh, explicit request context and User-scoped capability. Use a static service only if independent deployment justifies that boundary. Keep Dynamic Worker isolation for Plugins and Applets. This aligns with the repository's existing distinction between compiled App code and runtime Plugins; it is a proposed change, not part of the already agreed startup scope. It mainly affects REST/admission and initial page reads, because voice and observer sockets already bypass this layer.

## Repeated authentication reads

Native authentication first verifies and reads the revocable session, then calls account admission, then reads the profile used for the gateway's User/admin projection. With the current Better Auth adapter and host-owned admission, admission already reads the same identity row through `storedIdentity`; `profile` subsequently looks up that User again. The gateway correctly reuses the admission result: there is no second account-admission call on that path. Sources: [native authentication](../../apps/cloudflare/src/native-auth.ts#L394), [stored admission identity](../../apps/cloudflare/src/index.ts#L781), [D1 identity read](../../app/auth/better-auth/index.ts#L143), [profile read](../../app/auth/better-auth/index.ts#L197), [gateway reuse](../../apps/cloudflare/src/gateway.ts#L722).

**Recommendation:** resolve one fresh identity projection for this request and use it for admission and the gateway identity/admin result. Keep native-session revocation and current account-admission checks; they answer different questions. Respect auth Packages that own admission rather than assuming every adapter follows Better Auth. Do not introduce a long-lived auth cache or move authorization into the client. Handle identity failure/refusal explicitly and preserve the current admin/development policy.

## Repeated selected-Bot reads

The app's `requireRegisteredBot` invokes `UserBotState.assertRegistered`. That performs `hasBot`, then reads the entire Bot lifecycle directory to check one Bot. Later, Bot materialization calls `getBotRegistration` on the same User authority. This is a distinct directory issue from voice's all-Bot status fan-out: it does not wake every Bot, but it still reads account-wide data to authorize one. Sources: [route guard](../../apps/cloudflare/src/user-application.ts#L323), [membership and lifecycle reads](../../apps/cloudflare/src/index.ts#L1019), [registration](../../apps/cloudflare/src/bot-state.ts#L855), [materialization](../../apps/cloudflare/src/bot-state.ts#L1099).

**Recommendation:** expose a bounded selected-Bot access/registration result from the User authority. Reuse it where trust and revision semantics allow during one admitted request. Preserve the current distinctions between missing, archived and deleted Bots, permitted archived-history reads, and write refusal. A gateway assertion must not become an indefinite grant: changes between checks and execution need an explicit revision/authority rule, and direct internal Bot entry points must remain protected. This fits the agreed revisioned-preparation direction, but the precise RPC/capability shape needs implementation design.

## Verification requirements

- A normal REST request avoids the application-artifact lookup after the proposed routing change, while versioned client assets and update signals still agree.
- An authenticated request checks fresh session/account state without re-reading the same identity solely to construct the gateway projection.
- Selected-Bot authorization reads bounded data and retains missing/archive/delete behavior, including races with revocation and lifecycle changes.
- Plugin/Applet isolation, credential boundaries and direct socket authentication remain intact.

These can be verified with controlled dependencies and source-level call assertions. No timing benchmark is a prerequisite for this discussion, and no numerical speedup is claimed.
