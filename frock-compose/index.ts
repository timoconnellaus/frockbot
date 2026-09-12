// FrockBot Compose: the Plugin worker host.
//
// Untrusted code — Plugins the deployment seeded and Plugins a Bot wrote — runs
// in one loaded Worker per User with `globalOutbound` disabled and only its
// named grants. This module is what loads it: every Composition member's
// content-addressed artifact behind a generated index, the wrapper that
// narrows the capability stub into the `ctx` a Plugin author writes against,
// and the tool and hook registrations its health report declares.
export * from "./plugin-worker-host.ts";
export * from "./plugin-worker-wrapper.ts";
