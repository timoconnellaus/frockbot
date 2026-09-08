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
import type {
  ComputerHostV1,
  ComputerSyncHostV1,
} from "@frockbot/computer/core/host";
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

/** The per-Turn seams a Computer host is built over. */
export interface ShellComputerHostOptionsV1 {
  /**
   * The object-storage side of the durable roots, for one admitted Turn.
   * Absent, and the host offers no `sync` at all.
   */
  sync?: ComputerSyncHostV1;
  /** The `computerUse` task owner whose User-wide lease this child holds. */
  agentControlOwnerId?: string;
}

/**
 * This deployment's Computer host, as the app receives it.
 *
 * A factory rather than a value because two of the host's seams are per-Turn,
 * and a function rather than an interface because the app has exactly one
 * question to ask of it. Which host this is — Fly, or another — is chosen once
 * by the shell that holds the bindings; nothing in `app/` names an
 * implementation, which is what `scripts/check-computer-host-imports.ts`
 * rule 2 enforces.
 */
export type ShellComputerHostFactoryV1 = (
  options: ShellComputerHostOptionsV1,
) => ComputerHostV1;

/** The seams the Shell hands the application for the always-mounted Packages. */
export interface ShellHostedRuntimeHostV1 {
  userId: string;
  readSecret(name: string): string | undefined;
  /**
   * This deployment's Computer host. Absent, and there is no Computer at all:
   * no host registers, the Computer tools are not mounted, and every Computer
   * surface reads as unconfigured, which is the truth.
   */
  computerHost?: ShellComputerHostFactoryV1;
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
