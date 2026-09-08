import type { PackageDefinitionV1 } from "@frockbot/core/contracts";
import type { CredentialLeaseV1 } from "@frockbot/core/connection";
import type {
  BotExecutionPlanV1,
  ConnectionView,
  EnabledCapabilityV1,
  PackageSettingValueV1,
  ResolvedModelBindingV1,
} from "@frockbot/core/configuration";
import type { FoundationAgentPackage } from "@frockbot/app/agent-runtime";
import type { ComputerSyncHostV1 } from "@frockbot/computer/core";
import type {
  ComputerAgentPluginConfig,
  ComputerProcessStorageV1,
} from "@frockbot/computer/agent";
import type { AppletsRuntimeHostV1 } from "@frockbot/applets/feature";
import type { BotTemplateRuntimeHostV1 } from "@frockbot/app/bot-template/agent";
import type { FlockSelfRuntimeHostV1 } from "@frockbot/app/flock/agent";
import type { ImageRuntimeHostV1 } from "@frockbot/app/image/agent";
import type { MachineMessagesRuntimeHostV1 } from "@frockbot/app/machine-messages/agent";
import type { MachineRuntimeHostV1 } from "@frockbot/app/machine/agent";
import type { MemoryRuntimeHostV1 } from "@frockbot/app/memory/agent";
import type { RoutinesRuntimeHostV1 } from "@frockbot/app/routines/agent";
import type { SkillsRuntimeHostV1 } from "@frockbot/app/skills/agent";
import type { SubagentsRuntimeHostV1 } from "@frockbot/app/subagents/agent";

/**
 * The `COMPUTER_HOST` service binding and the secret presented on it.
 *
 * Both or neither: a binding with no token reaches a host that refuses every
 * call, which would surface as a 401 on each Turn rather than as a Computer
 * that is not configured.
 */
export interface ShellComputerHostBindingV1 {
  fetcher: { fetch(request: Request): Promise<Response> };
  hostToken: string;
}

/** The seams the Shell hands the application for the always-mounted Packages. */
export interface ShellHostedRuntimeHostV1 {
  userId: string;
  readSecret(name: string): string | undefined;
  /**
   * The shared Computer host: the service binding the Bot
   * Durable Object reaches a Computer through, and the secret it presents.
   * Absent, and the Fly provider registers unconfigured — this Worker holds
   * no Sprites SDK and no way to reach a Computer without it.
   */
  computerHostBinding?: ShellComputerHostBindingV1;
  /**
   * The Skills seam, supplied by the Bot Durable Object for one admitted
   * Turn. Absent outside a Turn, and outside one whose Workspace reads are
   * available, and the Skills Package is then not mounted: a Turn with no
   * readable instruction root loads no instructions rather than guessing.
   */
  skills?: SkillsRuntimeHostV1;
  /**
   * The Memory seam, supplied by the Bot Durable Object for one admitted
   * Turn. Absent outside a Turn, and outside one whose Memory roots are
   * reachable, and the Memory Package is then not mounted: a Turn with no
   * readable Memory root injects no Memory rather than guessing.
   */
  memory?: MemoryRuntimeHostV1;
  /**
   * The image-generation seam, supplied by the Bot Durable Object for one
   * admitted Turn. Absent outside a Turn, and outside one whose Workspace is
   * reachable, and the Image Package is then not mounted: a Bot generates an
   * image only inside a Turn whose Session and Turn the write can name, and
   * only where the file it produces has somewhere durable to land.
   */
  image?: ImageRuntimeHostV1;
  /**
   * The Routines seam, supplied by the Bot Durable Object for one admitted
   * Turn. Absent outside a Turn, and the Routines Package is then not
   * mounted: a Bot writes a Routine only inside a Turn whose Session and Turn
   * its provenance can name.
   */
  routines?: RoutinesRuntimeHostV1;
  /**
   * The Subagents seam, supplied by the parent Bot Durable Object
   * for one admitted Turn. Absent outside a Turn, and outside a deployment
   * that can address a Subagent Durable Object, and the Package is then not
   * mounted at all: a Bot dispatches a subagent only inside a Turn whose run
   * the task record can name.
   */
  subagents?: SubagentsRuntimeHostV1;
  /**
   * The Computer sync seam, supplied by the Bot Durable Object
   * for one admitted Turn. Absent outside a Turn, and outside one whose
   * durable roots are reachable in object storage — the Computer provider
   * then offers no sync at all, and a Computer's durable roots live on the
   * Computer alone rather than reconciling against a store no authority
   * backs.
   */
  computerSync?: ComputerSyncHostV1;
  /**
   * The Session and Turn a Computer write records as its writer, supplied by
   * the Bot Durable Object for one admitted Turn. Absent outside a Turn, and
   * `computer_screenshot` is then not offered: a durable-root write with no
   * Turn to name is a write with no writer.
   */
  computerWriter?: { sessionId: string; turnId: string; runId: string };
  /**
   * The Bot Durable Object storage a background process's record is written
   * to, supplied for one admitted Turn. Absent, and `computer_exec` offers
   * no `background` and the three process tools are not mounted: intent is
   * recorded before an effect, and with nowhere to record it there is no
   * honest way to launch a process that outlives its Turn.
   */
  computerProcesses?: ComputerProcessStorageV1;
  /** Wake-free access to the Bot DO's durable human-control record. */
  computerControlRecords?: NonNullable<
    ComputerAgentPluginConfig["controlRecords"]
  >;
  /** Resident projection caches invalidated after a known Computer write. */
  computerProjectionFiles?: NonNullable<
    ComputerAgentPluginConfig["projectionFiles"]
  >;
  /** The `computerUse` task owner whose User-wide lease this child holds. */
  computerAgentControlOwnerId?: string;
  /**
   * The Bot self-management seam, supplied by the Bot Durable Object for one
   * admitted Turn. Absent outside a Turn, and the Flock runtime Contribution
   * is then not mounted: a Bot changes its own identity, or adds a Bot to
   * its User's flock, only inside a Turn whose Session and Turn the write
   * can name.
   */
  botSelfManagement?: FlockSelfRuntimeHostV1;
  /**
   * The Bot Template seam, supplied by the Bot Durable Object for one
   * admitted Turn. Absent outside a Turn, and the export tool is then not
   * registered at all: staging a template runs through the User's own
   * command path, and a Turn with no such path cannot reach it.
   */
  botTemplate?: BotTemplateRuntimeHostV1;
  /**
   * The registered machine seam, supplied by the Bot Durable Object for one
   * admitted Turn. Absent outside a Turn, and the machine tools are then not
   * mounted at all: an intent record with no Session and Turn is an effect
   * nobody can trace back to a conversation.
   */
  machines?: MachineRuntimeHostV1;
  /**
   * Row 57g's seam, supplied only when all of its gate is open: the User
   * setting is on, and at least one connected macOS machine reports the
   * `messages` capability. Absent, and the seven Messages tools are not
   * mounted at all — absent from the catalog rather than present and
   * refusing, which is what a feature gate is for.
   */
  machineMessages?: MachineMessagesRuntimeHostV1;
  /**
   * The Applets seam, supplied by the Bot Durable Object for one admitted
   * Turn. Absent outside a Turn, and outside a deployment that can reach the
   * Applet Durable Object, its artifact bucket and the Workspace — and the
   * Applets Package is then not mounted at all: a publish is a durable effect
   * whose intent record has to name the Turn that asked for it.
   */
  applets?: AppletsRuntimeHostV1;
}

/** What the Shell hands the application to mount one Turn's enabled Packages. */
export interface ShellEnabledRuntimeHostV1 {
  userId: string;
  readSecret(name: string): string | undefined;
  pinToolCatalog?(
    connectionId: string,
    read: () => Promise<unknown>,
  ): Promise<unknown>;
  authorizeConnection(capability: EnabledCapabilityV1): Promise<ConnectionView>;
  /**
   * One Package's durable User-level setting values. Supplied by the host
   * that read the User's settings for this Turn; a host that supplies none
   * leaves every Contribution on its Package defaults.
   */
  packageSettings?(
    packageId: string,
  ): Readonly<Record<string, PackageSettingValueV1>> | undefined;
  /** The Package's own outbound seam, passed through to each Contribution. */
  fetch?: typeof fetch;
  /** The User's credential authority, for Contributions that hold a key. */
  leaseCredential?(
    capability: EnabledCapabilityV1,
    effectId: string,
    expectedGeneration?: string,
  ): Promise<CredentialLeaseV1>;
  settleCredential?(
    capability: EnabledCapabilityV1,
    effectId: string,
  ): Promise<void>;
}

/** What the Shell hands the application to mount this Turn's model provider. */
export interface ShellModelRuntimeHostV1 {
  accountId: string;
  connectionId: string;
  leaseCredential?(
    effectId: string,
    expectedGeneration?: string,
  ): Promise<CredentialLeaseV1>;
  settleCredential?(effectId: string): Promise<void>;
  frockAiAutoRoute?: string;
  runFrockAiChatCompletion?: (
    gatewayModel: string,
    body: Record<string, unknown>,
  ) => Promise<ReadableStream<Uint8Array>>;
  fetch?: typeof fetch;
}

/**
 * How the Shell mounts a Turn's runtime Packages.
 *
 * The Shell knows which seams a Turn has and which Packages its plan enables;
 * it does not know which implementation a Package id resolves to. The
 * application supplies these three factories, which is the whole of what the
 * Shell needs from the application that composes it.
 */
export interface ShellRuntimeFactoriesV1 {
  /**
   * The features every Turn mounts whatever its seams: the Bot's identity, the
   * built-in model, the demo tools and the Shell's own voice. Mounted last, so
   * a provider an earlier Package registered is already there.
   */
  base(): FoundationAgentPackage[];
  hosted(host: ShellHostedRuntimeHostV1): FoundationAgentPackage[];
  enabled(
    execution: BotExecutionPlanV1,
    host: ShellEnabledRuntimeHostV1,
  ): Promise<FoundationAgentPackage[]>;
  model(
    binding: ResolvedModelBindingV1,
    host: ShellModelRuntimeHostV1,
  ): FoundationAgentPackage;
}

/** The application's Packages, and the factories that mount them. */
export interface ShellApplicationV1 {
  /** Every Package this deployment ships, in Composition order. */
  packages: readonly PackageDefinitionV1[];
  /**
   * A first-party Package's version is the deploy, so every installation row
   * carries this one version rather than a version of its own.
   */
  packageVersion: string;
  runtime: ShellRuntimeFactoriesV1;
}
