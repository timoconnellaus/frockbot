// FrockBot Compose: the Bot isolate host.
//
// Untrusted code — Bot-authored and third-party — runs in a loaded Worker with
// `globalOutbound` disabled and only its named grants. This package is what
// loads it: the Composition member's content-addressed artifact, the generated
// wrapper that narrows the capability stub into the `ctx` a Package author
// writes against, and the tool registrations its health report declares.
export * from "./descriptor.ts";
export * from "./failure.ts";
export * from "./isolate-host.ts";
