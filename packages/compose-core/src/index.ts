/**
 * `@frockbot/compose-core` — the framework-agnostic kernel: the client, plugins,
 * context and deps, cleanup, status, options, middleware and events,
 * plugin-list reconciliation, and the host contract with the in-process host.
 *
 * Terms are the ones in `CONTEXT.md`; the design is in `DESIGN.md` next to this
 * file, and the contracts it meets are `docs/acceptance/kernel.md` and
 * `docs/acceptance/hosts.md` §A.
 */

export { createClient, optionsUpdateAction, reconcileAction } from "./client";
export {
  createAction,
  createContextKey,
  createEvent,
  createPlugin,
} from "./definitions";
export {
  createInProcessHost,
  createStub,
  inProcessHost,
  sourceErrorOf,
  stubCallAction,
  stubDeclarations,
} from "./host";

export type {
  ActionDefinition,
  ActionCall,
  ActionHandler,
  AnyAction,
  AnyContextKey,
  AnyDependency,
  AnyEvent,
  AnyPlugin,
  Cleanup,
  Client,
  ClientErrorReport,
  ContextKey,
  ContextSnapshot,
  ContextView,
  EventDefinition,
  InputOf,
  Instance,
  InstanceSnapshot,
  Listener,
  Middleware,
  OptionsInputOf,
  Plugin,
  PluginEntry,
  PluginObjectEntry,
  PluginSourceEntry,
  ResourceNode,
  ResultOf,
  Status,
  ValueOf,
} from "./definitions";

export type {
  AnyStubGrant,
  Host,
  HostInstance,
  HostStartRequest,
  HostStub,
  InProcessGrant,
  InProcessGrantContext,
  InProcessGrantInstance,
  SourceCheckResult,
  SourceChecker,
  SourceDiagnostic,
  SourceError,
  SourceExport,
  StubCall,
  StubGrant,
  StubHandler,
} from "./host";

export type {
  InferInput,
  InferOutput,
  StandardSchemaIssue,
  StandardSchemaResult,
  StandardSchemaV1,
} from "./standard-schema";
