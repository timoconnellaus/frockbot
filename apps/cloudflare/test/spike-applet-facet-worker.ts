// SPIKE (lane S1): the smallest honest stand-in for the `AppletState` Durable
// Object of `docs/plans/applets.md` §2.
//
// A kernel-owned Durable Object loads an Applet's server module through a
// Worker Loader binding, takes the loaded module's `Applet` class with
// `getDurableObjectClass`, and mounts it as a **facet** of itself. Everything
// the plan asks of that seam — SQL and key/value storage inside the facet,
// abort + remount of new code over the same storage, `facets.delete`, the
// `env` the facet sees, egress, a loopback capability stub, a hibernatable
// WebSocket, and an alarm — is exercised from here.
//
// Throwaway. It answers `docs/research/spike-applet-facets.md`; it is not
// production code and lane K3 replaces it.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

/**
 * The compatibility date the loaded Applet worker is pinned to. cloudflare-os
 * (`packages/workshop-backend/src/overseer.ts`) uses `2026-02-01`; this repo
 * pins its own isolates to `2026-08-27`, and the spike proves the later date
 * works so `AppletState` can stay on one date with the rest of the kernel.
 */
export const SPIKE_APPLET_COMPATIBILITY_DATE = "2026-08-27";

/**
 * Empty on purpose, and proven so: cloudflare-os passes
 * `allow_irrevocable_stub_storage` to its gadget worker, but every result in
 * `docs/research/spike-applet-facets.md` passes with **no** compatibility flag
 * on the loaded worker at this compatibility date.
 */
export const SPIKE_APPLET_COMPATIBILITY_FLAGS: string[] = [];

/** The one facet name the kernel mounts, per the plan. */
const FACET_NAME = "applet";

/** A key only the *parent* writes, to prove the facet cannot see it. */
const PARENT_ONLY_KEY = "parent-only";

export interface SpikeAppletIdentityV1 {
  appletId: string;
  generationId: string;
  contract: 1;
}

export interface SpikeCapabilitiesPropsV1 {
  appletId: string;
  /** The kernel object's name, so the capability can call back into it. */
  stateName: string;
}

/**
 * How many times a loader `getCode` callback actually ran, in this isolate.
 * Module scope rather than an instance field, because the callback may run
 * after the Durable Object instance that registered it is gone.
 */
let loaderCallbackRuns = 0;

/**
 * The `CAPABILITIES` slot of the facet's `env`. The prior loader spike
 * (`docs/research/spike-worker-loader-from-do.md` §3) found an `RpcTarget` in
 * `env` is rejected with `DataCloneError`, so this is a `WorkerEntrypoint`
 * minted as a loopback stub with `ctx.exports`.
 */
export class SpikeAppletCapabilities extends WorkerEntrypoint<
  SpikeAppletFacetEnv,
  SpikeCapabilitiesPropsV1
> {
  shout(text: string): string {
    return `${this.ctx.props.appletId}:${text.toUpperCase()}`;
  }

  /**
   * The workaround for "Facets currently cannot set alarms": the facet asks
   * the kernel object, through its capability stub, to hold the alarm on its
   * behalf.
   */
  async scheduleAlarm(delayMs: number): Promise<void> {
    await this.env.APPLET_FACETS.getByName(
      this.ctx.props.stateName,
    ).holdAlarmForFacet(delayMs);
  }
}

export interface SpikeAppletFacetEnv {
  APPLETS: WorkerLoader;
  APPLET_FACETS: DurableObjectNamespace<AppletStateSpike>;
  /** A leak canary: the facet must never see a host binding. */
  SECRET_TOKEN: string;
}

interface SpikeExports {
  SpikeAppletCapabilities(options: {
    props: SpikeCapabilitiesPropsV1;
  }): SpikeAppletCapabilities;
}

/**
 * The Applet server module a Bot would publish, in the shape the SDK's `Applet`
 * base class will take (`docs/plans/applets.md` §8): a `DurableObject`
 * subclass named `Applet`, plus a default `WorkerEntrypoint` so the loaded
 * worker is also callable without a facet (used by the loader-identity result).
 *
 * `version` is substituted so two module maps differ in observable behaviour
 * while writing to the same facet storage.
 */
export function spikeAppletModule(version: string): string {
  return `import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

const VERSION = ${JSON.stringify(version)};

export class Applet extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL)",
    );
  }

  version() {
    return VERSION;
  }

  async addNote(text) {
    this.ctx.storage.sql.exec("INSERT INTO notes (text) VALUES (?)", text);
    await this.ctx.storage.put("last-note", text);
    return this.listNotes();
  }

  listNotes() {
    return [
      ...this.ctx.storage.sql.exec("SELECT text FROM notes ORDER BY id"),
    ].map((row) => row.text);
  }

  async lastNote() {
    return (await this.ctx.storage.get("last-note")) ?? null;
  }

  envKeys() {
    return Object.keys(this.env).sort();
  }

  identity() {
    return this.env.IDENTITY;
  }

  async parentLeakProbe() {
    return {
      parentOnly: (await this.ctx.storage.get(${JSON.stringify(PARENT_ONLY_KEY)})) ?? null,
      secretToken: typeof this.env.SECRET_TOKEN,
      loader: typeof this.env.APPLETS,
      namespace: typeof this.env.APPLET_FACETS,
    };
  }

  async probeEgress() {
    try {
      const response = await fetch("https://example.com");
      return { blocked: false, detail: "status:" + response.status };
    } catch (error) {
      return { blocked: true, detail: String(error) };
    }
  }

  async capabilityCall(text) {
    return await this.env.CAPABILITIES.shout(text);
  }

  /** Recorded, not expected to work: workerd refuses alarms inside a facet. */
  async scheduleOwnAlarm(delayMs) {
    try {
      await this.ctx.storage.setAlarm(Date.now() + delayMs);
      return { set: true, detail: "" };
    } catch (error) {
      return { set: false, detail: String(error) };
    }
  }

  /** The workaround: the kernel object holds the alarm for the facet. */
  async scheduleAlarm(delayMs) {
    await this.env.CAPABILITIES.scheduleAlarm(delayMs);
  }

  /**
   * Present so \`scheduleOwnAlarm\` reaches workerd's real refusal rather than
   * the "must have an alarm() handler" type error. It never runs.
   */
  async alarm() {
    await this.ctx.storage.put("own-alarm-fired", true);
  }

  /** Called by the kernel object's own alarm handler. */
  async onAlarmTick() {
    const count = ((await this.ctx.storage.get("alarm-count")) ?? 0) + 1;
    await this.ctx.storage.put("alarm-count", count);
    await this.ctx.storage.put("alarm-version", VERSION);
  }

  async alarmReport() {
    return {
      count: (await this.ctx.storage.get("alarm-count")) ?? 0,
      version: (await this.ctx.storage.get("alarm-version")) ?? null,
    };
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response("applet:" + VERSION);
  }

  async webSocketMessage(ws, message) {
    ws.send(VERSION + ":echo:" + message);
  }
}

export default class extends WorkerEntrypoint {
  version() {
    return VERSION;
  }
}
`;
}

/**
 * A second module in the map, to prove a multi-module Applet artifact loads the
 * same way the Bot Package artifacts already do.
 */
function spikeAppletManifestModule(version: string): string {
  return `export const manifest = { contract: 1, version: ${JSON.stringify(version)} };\n`;
}

export function spikeAppletModules(
  version: string,
): Record<string, { js: string }> {
  return {
    "server.js": { js: spikeAppletModule(version) },
    "manifest.js": { js: spikeAppletManifestModule(version) },
  };
}

/** What the facet's RPC surface looks like from the parent's side. */
type SpikeAppletFacetStub = SpikeAppletFacet & {
  fetch(request: Request): Promise<Response>;
};

interface SpikeAppletFacet {
  version(): Promise<string>;
  addNote(text: string): Promise<string[]>;
  listNotes(): Promise<string[]>;
  lastNote(): Promise<string | null>;
  envKeys(): Promise<string[]>;
  identity(): Promise<SpikeAppletIdentityV1>;
  parentLeakProbe(): Promise<SpikeFacetLeakReportV1>;
  probeEgress(): Promise<SpikeEgressReportV1>;
  capabilityCall(text: string): Promise<string>;
  scheduleOwnAlarm(delayMs: number): Promise<SpikeOwnAlarmReportV1>;
  scheduleAlarm(delayMs: number): Promise<void>;
  onAlarmTick(): Promise<void>;
  alarmReport(): Promise<SpikeAlarmReportV1>;
}

export interface SpikeOwnAlarmReportV1 {
  set: boolean;
  detail: string;
  caughtInFacet?: boolean;
}

export interface SpikeFacetLeakReportV1 {
  parentOnly: string | null;
  secretToken: string;
  loader: string;
  namespace: string;
}

export interface SpikeEgressReportV1 {
  blocked: boolean;
  detail: string;
}

export interface SpikeAlarmReportV1 {
  count: number;
  version: string | null;
}

export interface SpikeMountInputV1 {
  loaderId: string;
  version: string;
}

/**
 * The kernel-owned object. Named for what it stands in for, not for the spike,
 * so the results read against the plan.
 */
export class AppletStateSpike extends DurableObject<SpikeAppletFacetEnv> {
  /** How many times a loader callback actually ran (cache proof). */
  loaderCalls(): number {
    return loaderCallbackRuns;
  }

  resetLoaderCalls(): void {
    loaderCallbackRuns = 0;
  }

  /** Writes a key only the parent owns; asserted still readable afterwards. */
  async seedParentStorage(value: string): Promise<void> {
    await this.ctx.storage.put(PARENT_ONLY_KEY, value);
  }

  async readParentStorage(): Promise<string | null> {
    return (await this.ctx.storage.get<string>(PARENT_ONLY_KEY)) ?? null;
  }

  #load(input: SpikeMountInputV1): WorkerStub {
    const exports = this.ctx.exports as unknown as SpikeExports;
    // The alarm workaround needs to remount the same code from the alarm
    // handler, so the mount input is durable, not just in memory.
    this.ctx.storage.kv.put("mount", input);
    return this.env.APPLETS.get(input.loaderId, () => {
      loaderCallbackRuns += 1;
      return {
        compatibilityDate: SPIKE_APPLET_COMPATIBILITY_DATE,
        compatibilityFlags: SPIKE_APPLET_COMPATIBILITY_FLAGS,
        mainModule: "server.js",
        modules: spikeAppletModules(input.version),
        // NOTE: `env` is captured by the loader the first time an id is
        // loaded and reused for every later `.get` of that id — including
        // from a *different* Durable Object. The identity below is the
        // object's own name so a result can prove that.
        env: {
          IDENTITY: {
            appletId: this.#stateName(),
            generationId: `gen-${input.version}`,
            contract: 1,
          } satisfies SpikeAppletIdentityV1,
          CAPABILITIES: exports.SpikeAppletCapabilities({
            props: {
              appletId: this.#stateName(),
              stateName: this.#stateName(),
            },
          }),
        },
        globalOutbound: null,
        limits: { cpuMs: 5_000, subRequests: 10 },
      };
    });
  }

  #facet(input: SpikeMountInputV1): SpikeAppletFacetStub {
    const stub = this.#load(input);
    return this.ctx.facets.get(FACET_NAME, () => ({
      class: stub.getDurableObjectClass(
        "Applet",
      ) as DurableObjectClass<undefined>,
      id: FACET_NAME,
    })) as unknown as SpikeAppletFacetStub;
  }

  // --- result 1: mount and call ------------------------------------------

  async mountAndVersion(input: SpikeMountInputV1): Promise<string> {
    return await this.#facet(input).version();
  }

  async addNote(input: SpikeMountInputV1, text: string): Promise<string[]> {
    return await this.#facet(input).addNote(text);
  }

  async listNotes(input: SpikeMountInputV1): Promise<string[]> {
    return await this.#facet(input).listNotes();
  }

  async lastNote(input: SpikeMountInputV1): Promise<string | null> {
    return await this.#facet(input).lastNote();
  }

  // --- result 2 / 3: remount and delete ----------------------------------

  abortFacet(reason: string): void {
    this.ctx.facets.abort(FACET_NAME, new Error(reason));
  }

  deleteFacet(): void {
    this.ctx.facets.delete(FACET_NAME);
  }

  // --- result 4: env, egress, capability ---------------------------------

  async facetEnvKeys(input: SpikeMountInputV1): Promise<string[]> {
    return await this.#facet(input).envKeys();
  }

  async facetIdentity(
    input: SpikeMountInputV1,
  ): Promise<SpikeAppletIdentityV1> {
    return await this.#facet(input).identity();
  }

  async facetLeakProbe(
    input: SpikeMountInputV1,
  ): Promise<SpikeFacetLeakReportV1> {
    return await this.#facet(input).parentLeakProbe();
  }

  async facetEgress(input: SpikeMountInputV1): Promise<SpikeEgressReportV1> {
    return await this.#facet(input).probeEgress();
  }

  async facetCapabilityCall(
    input: SpikeMountInputV1,
    text: string,
  ): Promise<string> {
    return await this.#facet(input).capabilityCall(text);
  }

  // --- result 5: WebSocket and alarm -------------------------------------

  /**
   * The parent forwards an upgrade to the facet's `fetch`, exactly as
   * `AppletState.connect(viewerTokenClaims, request)` will.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const version = url.searchParams.get("version") ?? "A";
    const loaderId = url.searchParams.get("loaderId") ?? `loader-${version}`;
    return await this.#facet({ loaderId, version }).fetch(request);
  }

  #stateName(): string {
    return this.ctx.id.name ?? "";
  }

  /** Recorded: what happens when the facet sets its own alarm. */
  async facetOwnAlarm(
    input: SpikeMountInputV1,
    delayMs: number,
  ): Promise<SpikeOwnAlarmReportV1> {
    try {
      return {
        ...(await this.#facet(input).scheduleOwnAlarm(delayMs)),
        caughtInFacet: true,
      };
    } catch (error) {
      // The refusal escapes the facet's own try/catch — see the spike doc.
      return { set: false, detail: String(error), caughtInFacet: false };
    }
  }

  /** The facet asks, through `CAPABILITIES`, for an alarm it cannot set. */
  async scheduleFacetAlarm(
    input: SpikeMountInputV1,
    delayMs: number,
  ): Promise<void> {
    await this.#facet(input).scheduleAlarm(delayMs);
  }

  /** Called back by `SpikeAppletCapabilities` on the facet's behalf. */
  async holdAlarmForFacet(delayMs: number): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + delayMs);
  }

  /** The kernel object owns the alarm and delivers the tick to the facet. */
  async alarm(): Promise<void> {
    const runs = (this.ctx.storage.kv.get<number>("alarm-runs") ?? 0) + 1;
    this.ctx.storage.kv.put("alarm-runs", runs);
    try {
      const input = this.ctx.storage.kv.get<SpikeMountInputV1>("mount");
      if (!input) {
        this.ctx.storage.kv.put("alarm-error", "no mount recorded");
        return;
      }
      await this.#facet(input).onAlarmTick();
    } catch (error) {
      this.ctx.storage.kv.put("alarm-error", String(error));
    }
  }

  parentAlarmDiagnostics(): { runs: number; error: string | null } {
    return {
      runs: this.ctx.storage.kv.get<number>("alarm-runs") ?? 0,
      error: this.ctx.storage.kv.get<string>("alarm-error") ?? null,
    };
  }

  async facetAlarmReport(
    input: SpikeMountInputV1,
  ): Promise<SpikeAlarmReportV1> {
    return await this.#facet(input).alarmReport();
  }

  /** Whether the kernel object is currently holding an alarm. */
  async parentAlarm(): Promise<number | null> {
    return await this.ctx.storage.getAlarm();
  }

  // --- result 6: loader identity, without facets in the way ---------------

  async loadedWorkerVersion(input: SpikeMountInputV1): Promise<string> {
    const entrypoint = this.#load(input).getEntrypoint<undefined>();
    return await (
      entrypoint as unknown as { version(): Promise<string> }
    ).version();
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response("spike-applet-facet-worker");
  },
};
