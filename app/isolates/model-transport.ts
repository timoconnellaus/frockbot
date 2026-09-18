// The model-provider Plugin transport, as the Bot Durable Object owns it
// (ADR 0032).
//
// A Plugin that serves a model provider never holds the credential, never
// names a destination and never decides whether it may send at all. It
// composes a wire body; the host resolves the Connection the Turn already
// admitted, sends that body to the one endpoint and route the deployment's
// provider catalog names, attaches the credential server-side and streams the
// provider's bytes back. Everything here is the host half of that.
//
// Four things are load-bearing. The ticket is minted per dispatch and spent
// by the call it is spent on, and the dispatch owns the abort, so a hung
// upstream call ends when its attempt does. The destination is compiled
// (or the Connection's own declared endpoint) and the route is a single
// inference route, so a Plugin cannot reach a provider's other billing,
// file or fine-tuning routes, another origin, a query or a redirect. The
// effect must be a durable one: the Turn's own log has to carry the
// `model/request` this ticket belongs to, and an effect that already settled
// is never sent again. And the credential is opened here, attached here, and
// never leaves this object.
import {
  decodePluginModelTransportRequestV1,
  pluginModelTransportUrlV1,
  type PluginModelTransportOutcomeV1,
} from "@frockbot/core/contracts";
import type { CredentialLeaseV1 } from "@frockbot/core/connection";
import type { Session } from "@frockbot/core/contracts";
import { CredentialLeaseRuntime } from "@frockbot/app/credentials/user";
import { retryAfterMillisecondsV1 } from "@frockbot/providers/openai-compatible";
import { decodeOAuthTokenV1 } from "@frockbot/providers/catalog/oauth-protocol";
import type { PluginServedProviderV1 } from "@frockbot/providers/catalog/definition";
import { DEPLOYMENT_PLUGIN_CATALOG_V1 } from "@frockbot/app/plugins/catalog";
import type { BotIdentity } from "@frockbot/core/durable";
import type { ShellBotStateV1 } from "@frockbot/app/shell/backend-state";
import { userConfigurationV1 } from "@frockbot/app/settings/bot";
import { compactionModelV1 } from "../shell/compaction.js";
import { compactionInFlightV1 } from "../shell/compaction-scheduler.js";
import { activeIsolateTurn } from "./authority.js";
import type {
  ModelDispatchHandleV1,
  PluginModelDispatchScopeV1,
} from "./model-dispatch.js";

/**
 * The largest output a body may ask for when the deployment's provider entry
 * names no bound of its own. A body is the Plugin's to compose, but how much
 * one call may spend is the host's: a provider bill is not something a Plugin
 * decides, and the provider must never choose the bound itself.
 */
export const PLUGIN_MODEL_MAX_OUTPUT_TOKENS_V1 = 32_768;

/**
 * The most output one call on a provider may ask for: the deployment's own
 * bound for the provider, and the selected model's own ceiling when the
 * Connection's catalog states one. Neither is the Plugin's to widen, and the
 * smaller of the two is what the transport checks a body against.
 */
export function pluginModelOutputBoundV1(
  entryBound: number,
  modelBound?: number,
): number {
  if (
    modelBound === undefined ||
    !Number.isSafeInteger(modelBound) ||
    modelBound <= 0
  ) {
    return entryBound;
  }
  if (!Number.isSafeInteger(entryBound) || entryBound <= 0) {
    return modelBound;
  }
  return Math.min(entryBound, modelBound);
}

/**
 * The host half of one Plugin's model provider contribution: where a dispatch
 * is opened, and how its credential lease is released when the loop settles
 * the call's outcome.
 */
export interface ShellPluginModelHostV1 {
  /** The provider the Bot's model selection names. */
  readonly provider: string;
  /**
   * The catalog Plugin that serves it, and the artifact it must be: a member
   * whose id or content hash differs is not this provider's Plugin, whatever
   * its descriptor claims.
   */
  readonly trusted: { pluginId: string; contentHash: string };
  /**
   * Opens one dispatch for one attempt at one model call. The ticket it
   * returns is what the Plugin's transport call must present, and ending the
   * attempt aborts any upstream call the ticket started.
   */
  begin(input: {
    scope: PluginModelDispatchScopeV1;
    /** The host's own session reference; the Plugin never names one. */
    session: Session;
    deadlineAt: number;
  }): ModelDispatchHandleV1;
  /** Releases the Connection's lease once the loop has settled the outcome. */
  settle(effectId: string): Promise<void>;
}

/**
 * The artifact the deployment's catalog installs for one Plugin. The hash is
 * what makes "this Plugin serves this provider" a fact about bytes rather
 * than about a descriptor a member carries.
 */
function deploymentArtifactHashV1(pluginId: string): string {
  const plugin = DEPLOYMENT_PLUGIN_CATALOG_V1.find(
    (entry) => entry.pluginId === pluginId,
  );
  if (!plugin) {
    throw new Error(
      `the deployment ships no Plugin "${pluginId}" for a provider it serves`,
    );
  }
  return plugin.artifact.contentHash;
}

/**
 * The model provider host for one Turn, when the Bot's model selection names
 * a provider this deployment serves through a Plugin. Everything trusted
 * comes from the compiled provider entry: which Plugin may serve it, which
 * Package its Connections belong to, and the endpoint and route its one call
 * may use.
 */
export function createPluginModelHostV1(
  state: ShellBotStateV1,
  identity: BotIdentity,
  binding: {
    provider: PluginServedProviderV1;
    connectionId: string;
    connectionGeneration: string;
    model: string;
    /** The bound the host admitted for this call, as the mount resolved it. */
    maxOutputTokens: number;
  },
): ShellPluginModelHostV1 {
  return {
    provider: binding.provider.provider,
    trusted: {
      pluginId: binding.provider.pluginId,
      contentHash: deploymentArtifactHashV1(binding.provider.pluginId),
    },
    begin: ({ scope, session, deadlineAt }) =>
      state.modelTransports.begin({
        requestId: scope.requestId,
        session,
        pluginId: binding.provider.pluginId,
        provider: binding.provider.provider,
        model: binding.model,
        connectionId: binding.connectionId,
        connectionGeneration: binding.connectionGeneration,
        packageId: binding.provider.packageId,
        endpoint: binding.provider.endpoint,
        route: binding.provider.route,
        maxOutputTokens: binding.maxOutputTokens,
        scope,
        deadlineAt,
      }).handle,
    settle: (effectId) =>
      userConfigurationV1(state, identity).settleModelCredential(
        identity.userId,
        binding.connectionId,
        binding.provider.packageId,
        effectId,
      ),
  };
}

function refused(
  reason: string,
  httpStatus = 0,
): PluginModelTransportOutcomeV1 {
  return { status: "refused", httpStatus, reason };
}

/**
 * The body one Plugin composed, checked against what the host admitted: the
 * same model, and no output ask beyond the bound. The bytes themselves are
 * forwarded unchanged, so the wire stays the Plugin's.
 */
export function pluginModelBodyRefusalV1(
  body: string,
  admitted: { model: string; maxOutputTokens?: number },
): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return "the model request body is not JSON";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return "the model request body is not an object";
  }
  const value = parsed as Record<string, unknown>;
  if (value.model !== admitted.model) {
    return `the model request body names a model this call was not admitted for`;
  }
  // One operation is approved: the streaming inference call.
  if (value.stream !== true) {
    return "the model request body is not the streaming inference call this deployment approves";
  }
  // DeepSeek's own output field, and only it. A body naming another dialect's
  // spelling is one this deployment does not recognise, and a body naming
  // none would leave the size of the call to the provider's default.
  if (
    value.max_completion_tokens !== undefined ||
    value.max_output_tokens !== undefined
  ) {
    return "the model request body names an output field this provider does not use";
  }
  const asked = value.max_tokens;
  const allowed = admitted.maxOutputTokens ?? PLUGIN_MODEL_MAX_OUTPUT_TOKENS_V1;
  if (
    !Number.isSafeInteger(asked) ||
    (asked as number) <= 0 ||
    (asked as number) > allowed
  ) {
    return "the model request body does not name an output bound this deployment allows";
  }
  return undefined;
}

/**
 * What the host itself makes of the status the provider answered with.
 *
 * Three things can have happened, and the difference is money. A 2xx is an
 * answer. A 4xx is the provider stating, before doing any work, that it will
 * not take this call — a key it will not accept, a request it will not
 * serve — and that is a definitive no-effect result, which the kernel may
 * classify and (where a retry is planned) treat as a call that did not bill.
 * A 5xx is a failure *after* the request arrived, which may mean the provider
 * accepted and processed it: whether it billed is unknown, so it is
 * uncertainty, never a refusal, and it is not retried.
 */
export function pluginModelStatusV1(
  status: number,
  retryAfterMs?: number,
):
  | { outcome: "streaming" }
  | { outcome: "uncertain"; reason: string }
  | {
      outcome: "refusal";
      classification: "transient" | "permanent" | "unknown";
      reason: string;
      retryAfterMs?: number;
    } {
  if (status >= 500) {
    return {
      outcome: "uncertain",
      reason: `the provider failed while answering (${status}), so the outcome of the model request is unknown`,
    };
  }
  if (status >= 400) {
    return {
      outcome: "refusal",
      // A rate limit is the one refusal worth trying again; the rest are the
      // provider's answer about this request and will not change on a retry.
      classification: status === 429 ? "transient" : "permanent",
      reason: `the provider rejected the model request (${status})`,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    };
  }
  if (status >= 300) {
    return {
      outcome: "refusal",
      classification: "permanent",
      reason:
        "the provider answered with a redirect, which this deployment does not follow",
    };
  }
  return { outcome: "streaming" };
}

/**
 * One credentialed upstream call for one admitted model dispatch.
 *
 * Everything a Plugin can influence is checked here: which dispatch the
 * ticket names, whether the Turn is still the one that opened it, whether the
 * Turn's own log carries the durable model effect this ticket is for,
 * whether that effect has already been sent and accounted, which Connection
 * the dispatch was admitted on and whether it is still ready, where the call
 * may go, what the body asks for, and what credential is attached. A refusal
 * before the fetch is a call that was never made.
 */
export async function isolateModelTransport(
  state: ShellBotStateV1,
  input: {
    userId: string;
    botId: string;
    runId: string;
    sessionId: string;
    turnId: string;
    packageId: string;
    generationId: string;
    request: unknown;
  },
): Promise<PluginModelTransportOutcomeV1> {
  const identity: BotIdentity = { userId: input.userId, botId: input.botId };
  let request;
  try {
    request = decodePluginModelTransportRequestV1(input.request);
  } catch (error) {
    // Decoded before the ticket is spent: a malformed call is refused without
    // costing the dispatch its one attempt.
    return refused(
      `the model transport request was refused: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const dispatch = state.modelTransports.take(request.transportId);
  if (!dispatch) {
    return refused(
      "the model call this transport belongs to is no longer running",
    );
  }
  if (
    dispatch.scope.runId !== input.runId ||
    dispatch.scope.sessionId !== input.sessionId ||
    dispatch.scope.turnId !== input.turnId ||
    dispatch.scope.generationId !== input.generationId ||
    dispatch.scope.botId !== input.botId ||
    dispatch.pluginId !== input.packageId
  ) {
    return refused("the model transport ticket belongs to another call");
  }
  // The Turn itself, not just a mounted worker: an ordinary model call is
  // dispatched by the loop of the Turn that asked for it. A summariser is the
  // one call that outlives its Turn — the compaction is detached on purpose —
  // and it is admitted below by the intent it wrote, while it is still
  // running and nothing else is.
  const active = activeIsolateTurn(state, input);
  if (Date.now() >= dispatch.deadlineAt) {
    return refused("the model call's time ran out before this transport began");
  }
  // The host's own reference to the session, captured when the composition
  // mounted: never one the Plugin named.
  const session = dispatch.session;
  // The durable effect, as the session's own log states it. An ordinary call
  // is the `model/request` the loop appended before dispatching it — a first
  // try, a retry under the same key, a re-dispatch after an eviction — and
  // the binding it named is what the call was admitted for. A summariser has
  // no `model/request`: its durable intent is the `conversation/compaction-intent`
  // it wrote before calling, keyed by the same effect id this dispatch names.
  const attempts = session.events.filter(
    (
      event,
    ): event is Extract<
      (typeof session.events)[number],
      { type: "model/request" }
    > =>
      event.type === "model/request" &&
      event.request.requestId === dispatch.requestId,
  );
  const intent = session.events.findLast(
    (
      event,
    ): event is Extract<
      (typeof session.events)[number],
      { type: "conversation/compaction-intent" }
    > =>
      event.type === "conversation/compaction-intent" &&
      event.effectId === dispatch.requestId,
  );
  if (attempts.length === 0 && intent === undefined) {
    dispatch.refusal = { httpStatus: 0, classification: "permanent" };
    return refused(
      "this model call has no durable dispatch in the log that asked for it",
    );
  }
  if (attempts.length > 0 && !active) {
    dispatch.refusal = { httpStatus: 0, classification: "permanent" };
    return refused(
      "the Package is not running in this Bot's active Composition",
    );
  }
  if (intent !== undefined) {
    const settled = session.events.some(
      (event) =>
        (event.type === "conversation/compacted" ||
          event.type === "conversation/compaction-failed") &&
        event.effectId === dispatch.requestId,
    );
    // One summariser effect is one upstream call: once its outcome is on the
    // log the intent is spent, and while it is running nothing else may be.
    if (settled) {
      dispatch.refusal = { httpStatus: 0, classification: "permanent" };
      return refused(
        "this summariser call already has an outcome and is not sent again",
      );
    }
    if (!compactionInFlightV1(session.id)) {
      dispatch.refusal = { httpStatus: 0, classification: "permanent" };
      return refused("the summariser that asked for this call is not running");
    }
    const source = compactionModelV1(session.events);
    if (
      intent.provider !== dispatch.provider ||
      intent.model !== dispatch.model ||
      source?.modelBinding?.connectionId !== dispatch.connectionId ||
      source.modelBinding?.connectionGeneration !==
        dispatch.connectionGeneration
    ) {
      dispatch.refusal = { httpStatus: 0, classification: "permanent" };
      return refused(
        "this summariser dispatch does not match the durable intent it names",
      );
    }
  }
  const admitted = attempts[0]?.request;
  if (
    admitted !== undefined &&
    (admitted.provider !== dispatch.provider ||
      admitted.model !== dispatch.model ||
      admitted.modelBinding?.connectionId !== dispatch.connectionId ||
      admitted.modelBinding?.connectionGeneration !==
        dispatch.connectionGeneration)
  ) {
    dispatch.refusal = { httpStatus: 0, classification: "permanent" };
    return refused(
      "this model dispatch does not match the durable effect it names",
    );
  }
  if (attempts.length > 1) {
    // The effect was dispatched once already and the kernel chose to send it
    // again, which it only does after an outcome it could not confirm. One
    // request id is one upstream call: whether the lost attempt reached the
    // provider and billed is exactly what is unknown, so sending again would
    // be a second paid call for one effect. The Turn settles on that instead
    // (ADR 0032, the conservative first slice), and the person's next message
    // is a new request id and a clean attempt.
    dispatch.refusal = { httpStatus: 0, classification: "permanent" };
    return refused(
      "this model request was already dispatched once and its outcome is uncertain; it is not sent twice",
    );
  }
  const user = await userConfigurationV1(state, identity).readConfiguration({
    schemaVersion: 1,
    userId: identity.userId,
  });
  const connection = user.connections.find(
    (candidate) => candidate.connectionId === dispatch.connectionId,
  );
  if (
    !connection ||
    connection.state !== "ready" ||
    !connection.generation ||
    connection.generation !== dispatch.connectionGeneration ||
    connection.packageId !== dispatch.packageId
  ) {
    return refused(
      "the Connection this model call runs on is unavailable, so nothing was sent",
    );
  }
  const endpoint =
    typeof connection.settings?.["api-base-url"] === "string"
      ? connection.settings["api-base-url"]
      : dispatch.endpoint;
  const destination = pluginModelTransportUrlV1(endpoint, dispatch.route);
  if (destination.status !== "ok") {
    return refused(destination.reason);
  }
  const bodyRefusal = pluginModelBodyRefusalV1(request.body, dispatch);
  if (bodyRefusal !== undefined) return refused(bodyRefusal);
  let secret: string;
  try {
    const lease: CredentialLeaseV1 = await userConfigurationV1(
      state,
      identity,
    ).leaseModelCredential(
      identity.userId,
      dispatch.connectionId,
      dispatch.model,
      dispatch.requestId,
      dispatch.connectionGeneration,
    );
    secret = await credentialRuntimeV1(state).open({
      accountId: identity.userId,
      connectionId: dispatch.connectionId,
      packageId: connection.packageId,
      lease,
    });
  } catch {
    // A lease the Connection refuses is not a provider failure: nothing was
    // sent, and the reason stays the host's.
    dispatch.refusal = { httpStatus: 0, classification: "unknown" };
    return {
      status: "unavailable",
      reason:
        "this Bot's model credential is unavailable, so the request was not sent",
    };
  }
  const token = bearerTokenV1(secret);
  if (token === undefined) {
    dispatch.refusal = { httpStatus: 0, classification: "unknown" };
    return {
      status: "unavailable",
      reason:
        "this Bot's model credential is unavailable, so the request was not sent",
    };
  }
  // The upstream call is owned by the dispatch: the attempt ending for any
  // reason aborts it, and so does the first-byte allowance passing.
  const timer = setTimeout(
    () => dispatch.abort.abort(new Error("the model dispatch deadline passed")),
    Math.max(0, dispatch.deadlineAt - Date.now()),
  );
  try {
    const response = await fetchV1(state)(destination.url, {
      // Fixed by the host: POST, no redirects followed, and nothing the
      // Plugin sends can change the origin, the route or the credential.
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        authorization: `Bearer ${token}`,
        "idempotency-key": dispatch.requestId,
      },
      body: request.body,
      redirect: "manual",
      signal: dispatch.abort.signal,
    });
    // Headers arrived, so the first-byte allowance has done its work: what
    // happens to the body is the model protocol's silence rule to bound.
    clearTimeout(timer);
    // The provider's body is deliberately never forwarded for a failure: its
    // error prose can echo request content, and the Plugin has no use for it
    // that the host's own reading of the status does not cover.
    const status = pluginModelStatusV1(
      response.status,
      retryAfterMillisecondsV1(response.headers.get("retry-after")),
    );
    if (status.outcome === "uncertain") {
      await response.body?.cancel();
      // No refusal is recorded: the adapter reports an outcome the kernel
      // settles with the estimate rather than a call that did not happen.
      return { status: "unavailable", reason: status.reason };
    }
    if (status.outcome === "refusal") {
      await response.body?.cancel();
      dispatch.refusal = {
        httpStatus: response.status,
        classification: status.classification,
        ...(status.retryAfterMs === undefined
          ? {}
          : { retryAfterMs: status.retryAfterMs }),
      };
      return {
        status: "refused",
        httpStatus: response.status,
        reason: status.reason,
        ...(status.retryAfterMs === undefined
          ? {}
          : { retryAfterMs: status.retryAfterMs }),
      };
    }
    if (!response.body) {
      // A 200 with no body is a call the provider may well have billed, so
      // no refusal is recorded: the adapter reports an uncertain outcome
      // rather than a call that did not happen.
      return {
        status: "unavailable",
        reason: "the provider answered with no body, so the outcome is unknown",
      };
    }
    return {
      status: "streaming",
      httpStatus: response.status,
      // A Plugin that stops reading — its own deadline, a Stop, the Turn
      // ending — cancels the upstream request rather than leaving it running.
      body: guardedBodyV1(response.body, () => {
        if (!dispatch.abort.signal.aborted) {
          dispatch.abort.abort(new Error("the model transport was abandoned"));
        }
      }),
    };
  } catch {
    clearTimeout(timer);
    // A call that never answered may or may not have reached the provider —
    // the request may have been accepted and the connection lost — so this is
    // uncertainty, not a refusal: the adapter reports an outcome the kernel
    // settles with the estimate rather than a call that never happened.
    return {
      status: "unavailable",
      reason:
        "the provider could not be reached, so the outcome of the model request is unknown",
    };
  }
}

/** The credential store, built from this object's keyring binding. */
function credentialRuntimeV1(state: ShellBotStateV1): CredentialLeaseRuntime {
  // SAFETY: `CREDENTIAL_KEYRING` is a Worker secret binding, not enumerable
  // in the object's Env type; every other reader of one reads it the same way.
  const readSecret = (name: string): string | undefined => {
    const value = (state.env as unknown as Record<string, unknown>)[name];
    return typeof value === "string" ? value : undefined;
  };
  return new CredentialLeaseRuntime({ readSecret });
}

/**
 * The token a Connection's stored secret stands for. An API key is the
 * secret; a sign-in is its access token, and one that has expired is no
 * credential at all rather than a bearer header the provider would reject.
 */
function bearerTokenV1(secret: string): string | undefined {
  let oauth;
  try {
    oauth = decodeOAuthTokenV1(secret);
  } catch {
    // A sign-in envelope this deployment cannot read is not a key: refusing
    // beats attaching a bearer header the provider would reject.
    return undefined;
  }
  if (!oauth) return secret.length > 0 ? secret : undefined;
  if (!Number.isFinite(oauth.expires) || oauth.expires <= Date.now()) {
    return undefined;
  }
  return oauth.access;
}

/** The shape this module needs of a fetcher; the host seam is wider. */
type ModelFetchV1 = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

function fetchV1(state: ShellBotStateV1): ModelFetchV1 {
  const injected = state.outboundFetch;
  if (injected) return (input, init) => injected(input, init);
  // Workerd rejects a detached global `fetch` ("Illegal invocation"), so the
  // default forwards through a closure rather than aliasing it.
  return (input, init) => globalThis.fetch(input, init);
}

/**
 * The upstream body, as the Plugin reads it. The reader is ours, so a Plugin
 * that stops reading cancels the upstream request rather than leaving it to
 * run to completion.
 */
function guardedBodyV1(
  body: ReadableStream<Uint8Array>,
  abort: () => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      abort();
      await reader.cancel(reason);
    },
  });
}
