import type { ModelBilling } from "../billing/model.js";
import type { TurnTypeV1, WorkspaceFilesV1 } from "@frockbot/core/contracts";
import type { BotSettingsViewV1 } from "@frockbot/core/configuration";
import {
  BotDurableAuthority,
  type BotDurableAuthorityOptions,
} from "@frockbot/core/durable";
import type { BotIsolateLoader } from "@frockbot/frock-compose";
import { RoutineInboxStore } from "@frockbot/app/routines/inbox-store";
import type { RoutineScheduler } from "@frockbot/app/routines/scheduler";
import type { RoutineStore } from "@frockbot/app/routines/store";
import { TaskStore, type TaskStorageV1 } from "@frockbot/app/subagents/store";
import {
  createBotSubagentDurableBindingV1,
  type SubagentDurableBindingV1,
} from "@frockbot/app/subagents/durable-binding";
import type { AppletInstanceNamespaceV1 } from "@frockbot/app/applets-host/records";
import type { ShellMountedComposition } from "./backend-composition.js";
import { storedRunCodecV1 } from "./backend-contracts.js";
import type { NativeAiBindingV1 } from "./backend-image.js";
import {
  createBotRoutineHookMinter,
  createBotRoutines,
} from "@frockbot/app/routines/bot";
import { deliverPluginTriggerV1 } from "@frockbot/app/plugins/triggers-bot";
import type { ConfigurationActivityV1 } from "@frockbot/app/settings/bot";
import type {
  ShellApplicationV1,
  ShellComputerHostFactoryV1,
} from "./backend-runtime.js";

export interface BotStateEnv {
  BILLING?: (userId: string, botId: string, sessionId: string) => ModelBilling;
  MEMORY_FILES: R2Bucket;
  /** Object-storage file surfaces constructed by the Cloudflare adapter. */
  WORKSPACE_FILES?: WorkspaceFilesV1;
  MEMORY_WORKSPACE_FILES?: WorkspaceFilesV1;
  /**
   * The Bot Package Worker Loader (plan Step 4). Optional so a host without
   * Bot-authored Packages — tests, the Electron shell — still compiles; a
   * generation with an isolate member fails verification without it.
   */
  BOT_PACKAGES?: BotIsolateLoader;
  /** Immutable, content-addressed Package artifacts, read hash-verified. */
  APPLICATION_ARTIFACTS?: R2Bucket;
  /**
   * One Applet Durable Object per Applet instance. Optional so a host without
   * Applets still compiles; a Composition generation carrying an Applet member
   * then fails verification, exactly as an isolate member does without a
   * loader.
   */
  APPLET_STATES?: AppletInstanceNamespaceV1;
  /** Optional in local and workerd hosts, which have no Vectorize simulator. */
  MEMORY_INDEX?: VectorizeIndex;
  /** The native AI binding consumed through the image Package adapter. */
  AI?: NativeAiBindingV1;
  /** The Frock AI Gateway adapter constructed by the Cloudflare host. */
  FROCK_AI?: {
    autoRoute: string;
    runChatCompletion(
      gatewayModel: string,
      body: Record<string, unknown>,
    ): Promise<ReadableStream<Uint8Array>>;
  };
  USER_CONFIGURATIONS: DurableObjectNamespace;
  /**
   * The Bot Durable Object namespace, as the Subagent Durable Object namespace:
   * the same class, named `<userId>:<botId>#task:<taskId>`. Optional so a host
   * without it still compiles — `Task` is then not offered at all, rather than
   * offered and unable to dispatch.
   */
  BOT_STATES?: DurableObjectNamespace;
  COMPUTER_HOST?: Fetcher;
  /**
   * The Applet build service. Optional so a host without it still compiles; a
   * publish is then refused with "the build service is unavailable" rather
   * than throwing inside a Turn.
   */
  APPLET_BUILD?: Fetcher;
  /** The shared secret presented on every Applet build call. */
  APPLET_BUILD_TOKEN?: string;
  /**
   * The deployment's own origin. Applets derive the anonymous artifact origin
   * from it for the preview URL a check hands the Bot.
   */
  BETTER_AUTH_URL?: string;
  /**
   * The shared secret the app Worker presents to the Computer host. Absent,
   * and no Computer host call is made: an unauthenticated call would be
   * refused at the host anyway, and a missing secret is a deployment fault
   * that should be visible as "no Computer" rather than as a 401 per Turn.
   */
  COMPUTER_HOST_TOKEN?: string;
  CREDENTIAL_KEYRING?: string;
  /**
   * The HMAC secret every Routine webhook key is signed with. Absent in a
   * deployment that has not set it, and a webhook Routine is then refused a key
   * with that reason rather than given an unverifiable one.
   */
  ROUTINE_HOOK_SECRET?: string;
}

/** Constructs the kernel Bot Durable Object authority this Package runs under. */
export type CreateBotDurableAuthority = <Snapshot>(
  options: BotDurableAuthorityOptions<Snapshot>,
) => BotDurableAuthority<Snapshot>;

export interface ShellBotBackendHost extends ShellApplicationV1 {
  state: DurableObjectState;
  env: BotStateEnv;
  assertLifecycleActive?(
    storage: DurableObjectTransaction,
    botId: string,
  ): Promise<void>;
  outboundFetch?: typeof fetch;
  messagesCommitted?(): void;
  /** Supplied by the Durable Object; defaults to the kernel implementation. */
  createAuthority?: CreateBotDurableAuthority;
  /**
   * Durable Object addressing for subagent dispatch. Absent, and `Task` is not
   * offered at all: a Package that cannot reach a Subagent Durable Object has
   * no honest way to dispatch one.
   */
  subagents?: SubagentDurableBindingV1;
  invalidateComputerProjectionFile?(
    userId: string,
    botId: string,
    kind: "screenshots" | "doctor",
  ): void;
  /**
   * This deployment's Computer host. The Durable Object's own shell chooses
   * which one it is; nothing under `app/` names an implementation.
   */
  computerHost?: ShellComputerHostFactoryV1;
  /** Package deadlines composed into the Bot authority's one durable alarm. */
  scheduledDeadlines?(transaction: DurableObjectTransaction): Promise<number[]>;
  scheduledWorkInFlight?(): boolean;
  deferScheduledWork?(transaction: DurableObjectTransaction): Promise<void>;
  settleScheduledWork?(): Promise<void>;
  /** The clock and the timer, as seams a test replaces. */
  now?(): Date;
  sleep?(milliseconds: number): Promise<void>;
}

/** The Turn currently executing on this object, for durable Stop. */
export interface ActiveTurnV1 {
  runId: string;
  sessionId: string;
  turnId: string;
  generationId: string;
  turnType: TurnTypeV1;
  subagentRole?: string;
  mounted: ShellMountedComposition;
  signal: AbortSignal;
  /** `detail` is recorded on the Turn's `turn/end`, never interpreted. */
  cancel(detail?: string): void;
}

/**
 * A Plugin worker mounted outside any Turn — a trigger delivery, a section
 * render, a control's press (ADR 0026 steps 8–9). It is shaped like a Turn
 * so every loopback call still names what it is for, and the grants admit it
 * the way they admit the resident Turn: only for a Plugin it mounted.
 */
export interface StandaloneIsolateCallV1 {
  runId: string;
  sessionId: string;
  turnId: string;
  generationId: string;
  members: readonly { packageId: string; artifact?: unknown }[];
}

/**
 * The one resident Turn slot. Turn execution writes it; the Applets host and
 * the isolate grants read it, which is why it is a named accessor rather than
 * a private field of the composing class. Standalone calls sit beside the
 * Turn, keyed by run: several may be in flight, none of them is the Turn.
 */
export class ActiveTurnSlotV1 {
  #active: ActiveTurnV1 | undefined;
  readonly #standalone = new Map<string, StandaloneIsolateCallV1>();

  get current(): ActiveTurnV1 | undefined {
    return this.#active;
  }

  /** Registers a standalone call; the answer releases it. */
  beginStandalone(call: StandaloneIsolateCallV1): () => void {
    this.#standalone.set(call.runId, call);
    return () => {
      if (this.#standalone.get(call.runId) === call) {
        this.#standalone.delete(call.runId);
      }
    };
  }

  standalone(runId: string): StandaloneIsolateCallV1 | undefined {
    return this.#standalone.get(runId);
  }

  set(active: ActiveTurnV1): void {
    this.#active = active;
  }

  /** Clears the slot only if `active` is still the Turn holding it. */
  clear(active: ActiveTurnV1): void {
    if (this.#active === active) this.#active = undefined;
  }

  /** Cancels the resident Turn of one exact run; false if it is not resident. */
  interrupt(runId: string, reason?: string): boolean {
    const active = this.#active;
    if (!active || active.runId !== runId) return false;
    active.cancel(reason);
    return true;
  }

  /**
   * Cancels the resident Turn of one exact admitted run. A late Stop that
   * names a run this object is not executing changes nothing.
   */
  cancel(cancellation: {
    sessionId: string;
    runId: string;
    detail?: string;
  }): boolean {
    const active = this.#active;
    if (
      !active ||
      active.runId !== cancellation.runId ||
      active.sessionId !== cancellation.sessionId
    ) {
      return false;
    }
    active.cancel(cancellation.detail);
    return true;
  }
}

/** The Package deadlines the host composes into this object's one alarm. */
export interface HostScheduledWorkV1 {
  deadlines?: ShellBotBackendHost["scheduledDeadlines"];
  inFlight?: ShellBotBackendHost["scheduledWorkInFlight"];
  defer?: ShellBotBackendHost["deferScheduledWork"];
  settle?: ShellBotBackendHost["settleScheduledWork"];
}

/**
 * Everything a Bot feature module needs from the Durable Object, built once
 * per object and passed to each feature function. No module holds a reference
 * back to the contribution that composes them.
 */
export class ShellBotStateV1 {
  readonly ctx: DurableObjectState;
  readonly env: BotStateEnv;
  readonly application: ShellApplicationV1;
  /** The Turn currently executing on this object. */
  readonly turn = new ActiveTurnSlotV1();
  /**
   * The Routines authority for this Bot. One store per object, over the same
   * Durable Object storage every other durable record lives in.
   */
  readonly routines: RoutineStore;
  /**
   * The Routine scheduler, composed into the object's one alarm. It owns no
   * alarm of its own: `scheduledDeadlines`, `deferScheduledWork` and
   * `settleScheduledWork` are the whole of its access to the clock.
   */
  readonly routineScheduler: RoutineScheduler;
  /**
   * The completion inbox and the pending-input queue. An automation Turn cannot
   * speak to its User, so this is where its outcome lands, written in the same
   * transaction that settles the Turn.
   */
  readonly routineInbox: RoutineInboxStore;
  /**
   * The subagent task authority. In a parent Bot Durable Object it holds the
   * Bot's tasks; in a Subagent Durable Object it holds nothing, because a child
   * never dispatches one.
   */
  readonly tasks: TaskStore;
  /**
   * Configuration commands in flight on this object, so a retried command
   * joins the write already running rather than starting a second one.
   */
  readonly configurationActivities = new Map<string, ConfigurationActivityV1>();
  readonly subagentBinding: SubagentDurableBindingV1 | undefined;
  readonly outboundFetch: typeof fetch | undefined;
  /**
   * What the shell does when a user-visible message has been committed: drain
   * the push outbox. The kernel calls it for every message a Turn's settlement
   * writes; a message written outside a Turn — a Routine firing that broke —
   * owes the same call, or its notification waits for the next alarm.
   */
  readonly messagesCommitted: () => void;
  readonly lifecycleAdmission: ShellBotBackendHost["assertLifecycleActive"];
  readonly invalidateComputerProjectionFile: ShellBotBackendHost["invalidateComputerProjectionFile"];
  /** This deployment's Computer host, handed in by the shell. */
  readonly computerHost: ShellComputerHostFactoryV1 | undefined;
  readonly hostScheduled: HostScheduledWorkV1;
  readonly now: () => Date;
  readonly sleep: (milliseconds: number) => Promise<void>;
  /**
   * Admission, the event log, the cursor, idempotency, cancellation, and
   * durable scheduling are kernel authority; the app supplies only the
   * configuration, Composition, and notification policy it needs.
   */
  readonly authority: BotDurableAuthority<BotSettingsViewV1>;

  constructor(
    host: ShellBotBackendHost,
    hooks: (
      state: ShellBotStateV1,
    ) => BotDurableAuthorityOptions<BotSettingsViewV1>["hooks"],
  ) {
    this.ctx = host.state;
    this.env = host.env;
    this.application = {
      packages: host.packages,
      packageVersion: host.packageVersion,
      runtime: host.runtime,
    };
    this.lifecycleAdmission = host.assertLifecycleActive;
    this.outboundFetch = host.outboundFetch;
    this.messagesCommitted = () => host.messagesCommitted?.();
    this.invalidateComputerProjectionFile =
      host.invalidateComputerProjectionFile;
    this.computerHost = host.computerHost;
    this.hostScheduled = {
      deadlines: host.scheduledDeadlines,
      inFlight: host.scheduledWorkInFlight,
      defer: host.deferScheduledWork,
      settle: host.settleScheduledWork,
    };
    this.now = host.now ?? (() => new Date());
    this.sleep =
      host.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
    // The hook minter reads the identity through the authority this constructor
    // has not built yet, so the read stays deferred.
    const routines = createBotRoutines(
      host.state.storage,
      createBotRoutineHookMinter(
        () => this.authority.readDurableIdentity(),
        host.env.ROUTINE_HOOK_SECRET,
      ),
      // A Plugin trigger (ADR 0026) reaches the Plugin worker through this
      // object's own seams; the identity is read the same deferred way.
      {
        deliver: async (input) => {
          const owner = await this.authority.readDurableIdentity();
          if (!owner) {
            return {
              status: "drop",
              reason: "this Bot has no durable identity",
            };
          }
          return deliverPluginTriggerV1(this, owner, input);
        },
      },
    );
    this.routines = routines.store;
    this.routineScheduler = routines.scheduler;
    this.routineInbox = new RoutineInboxStore(host.state.storage);
    this.tasks = new TaskStore(host.state.storage as unknown as TaskStorageV1);
    this.subagentBinding =
      host.subagents ??
      (host.env.BOT_STATES
        ? createBotSubagentDurableBindingV1(host.env.BOT_STATES)
        : undefined);
    const createAuthority: CreateBotDurableAuthority =
      host.createAuthority ?? ((options) => new BotDurableAuthority(options));
    this.authority = createAuthority<BotSettingsViewV1>({
      state: host.state,
      codec: storedRunCodecV1,
      hooks: hooks(this),
    });
  }
}

/** The application's Packages in the shape the configuration resolvers read. */
export function executionPackagesV1(application: ShellApplicationV1) {
  return application.packages.map((pkg) => ({
    packageId: pkg.id,
    version: application.packageVersion,
    settings: [...(pkg.settings ?? [])],
    capabilities: [...(pkg.capabilities ?? [])],
    connectionTypes: [...(pkg.connectionTypes ?? [])],
  }));
}
