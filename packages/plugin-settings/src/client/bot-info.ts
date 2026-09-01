/**
 * The per-Bot info pane's projection.
 *
 * Register row 51: GrokBot's info pane shows a live preview of the agent's
 * computer over its routines and members. The Computer preview and the
 * Routines summary are their own Packages' Contributions; what this module owns
 * is the part that is Bot configuration — who the Bot is, how it was named,
 * and what authority it holds.
 *
 * It is a pure projection of durable state the client already read, with no
 * Vue and no DOM, so the shape the pane renders can be tested without mounting
 * anything.
 */
import type {
  BotSettingsViewV1,
  ConnectionView,
} from "@frockbot/configuration-core";
import type { PluginCatalogItem } from "@frockbot/plugin-shell/shared";

/** One Capability the Bot has been granted, named the way a person reads it. */
export interface BotInfoCapabilityV1 {
  /** Stable key for a list render; the Assignment id when there is one. */
  key: string;
  assignmentId: string;
  packageId: string;
  /** The Package's display name, or its id when the catalog no longer has it. */
  packageName: string;
  capabilityId: string;
  /** The Connection the Assignment is bound to, when it needs one. */
  connectionName?: string;
  state: "enabled" | "disabled" | "unavailable";
  /** True when the catalog no longer offers the Capability this grants. */
  orphaned: boolean;
}

export interface BotInfoProjectionV1 {
  botId: string;
  name: string;
  title?: string;
  label?: string;
  description?: string;
  /** How the Bot came by its current name, in words. */
  namedBy: "user" | "bot" | "unrecorded";
  namedByLabel: string;
  /** The digest of an uploaded avatar; absent means the generated sheep. */
  avatarDigest?: string;
  notificationsEnabled: boolean;
  hiddenFromSidebar: boolean;
  capabilities: readonly BotInfoCapabilityV1[];
  /** How many Assignments are live enough to grant anything. */
  enabledCapabilityCount: number;
}

const NAMED_BY_LABELS: Record<BotInfoProjectionV1["namedBy"], string> = {
  user: "Named by you",
  bot: "Named by itself",
  unrecorded: "Name provenance not recorded",
};

export interface BotInfoInputV1 {
  settings?: BotSettingsViewV1;
  catalog?: readonly PluginCatalogItem[];
  connections?: readonly ConnectionView[];
}

/**
 * Project the pane. Returns `undefined` until the Bot's settings have loaded:
 * the pane renders durable state, and an empty shape would be a claim about a
 * Bot nobody has read yet.
 */
export function projectBotInfoV1(
  input: BotInfoInputV1,
): BotInfoProjectionV1 | undefined {
  const settings = input.settings;
  if (!settings) return undefined;
  const catalog = input.catalog ?? [];
  const connections = input.connections ?? [];
  const capabilities = settings.assignments.map((assignment) => {
    const pkg = catalog.find(
      (candidate) => candidate.packageId === assignment.packageId,
    );
    const capability = pkg?.capabilities.find(
      (candidate) => candidate.id === assignment.capabilityId,
    );
    const connection = assignment.connectionId
      ? connections.find(
          (candidate) => candidate.connectionId === assignment.connectionId,
        )
      : undefined;
    return {
      key: assignment.assignmentId,
      assignmentId: assignment.assignmentId,
      packageId: assignment.packageId,
      packageName: pkg?.displayName ?? assignment.packageId,
      capabilityId: assignment.capabilityId,
      ...(connection ? { connectionName: connection.displayName } : {}),
      state: assignment.state,
      orphaned: !capability,
    } satisfies BotInfoCapabilityV1;
  });
  const namedBy = settings.profile.namedBy ?? "unrecorded";
  return {
    botId: settings.botId,
    name: settings.profile.name,
    ...(settings.profile.title ? { title: settings.profile.title } : {}),
    ...(settings.profile.label ? { label: settings.profile.label } : {}),
    ...(settings.profile.description
      ? { description: settings.profile.description }
      : {}),
    namedBy,
    namedByLabel: NAMED_BY_LABELS[namedBy],
    ...(settings.profile.avatar?.kind === "image"
      ? { avatarDigest: settings.profile.avatar.digest }
      : {}),
    notificationsEnabled: settings.notifications.enabled,
    hiddenFromSidebar: settings.profile.hiddenFromSidebar === true,
    capabilities,
    enabledCapabilityCount: capabilities.filter(
      (capability) => capability.state === "enabled",
    ).length,
  };
}
