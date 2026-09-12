// FrockBot Compose: the Plugin worker host.
//
// Untrusted code — Plugins the deployment seeded and Plugins a Bot wrote — runs
// in one loaded Worker per User with only its named grants and a
// `globalOutbound` that admits only the hosts the User approved. This module is
// what loads it: every Composition member's content-addressed artifact behind a
// generated index, the wrapper that narrows the capability stub into the `ctx`
// a Plugin author writes against, and the tool and hook registrations its
// health report declares.
export * from "./plugin-worker-host.ts";
