// A Bot's conversation panels: the bag, the focused surface, and bot.nav
// (ADR 0034).
//
// The pointer lives on the Bot Durable Object. The bag is this Bot's enabled
// Plugins. A focused surface that has left the bag is cleared rather than
// jumping to a neighbour. `renderView` always names this Bot.
import {
  decodeProtocol,
  type ViewDocument,
} from "@frockbot/core/protocol-schemas";
import {
  decodeFocusedPanelV1,
  focusedPanelV1,
  PANEL_FOCUSED_KEY,
  type FocusedPanelV1,
} from "@frockbot/core/durable";
import type { BotIdentity } from "@frockbot/core/durable";
import {
  pluginPageStateV1,
  pluginPageUrlV1,
  type PluginWorkerViewResultV1,
} from "@frockbot/core/contracts";
import { pluginMountOrderV1 } from "@frockbot/frock-compose";
import type { ShellBotStateV1 } from "@frockbot/app/shell/backend-state";
import {
  PLUGIN_TOOL_ACTION_ID_V1,
  MAX_PLUGIN_TOOL_ARGUMENTS_BYTES_V1,
  pluginPageV1,
  pluginSectionV1,
  type BotPluginSectionV1,
} from "./views.js";
import {
  botNavDoorsV1,
  conversationPanelBagV1,
  omittedPanelsCopyV1,
  resolvePanelFocusV1,
  type PluginNavDoorV1,
  type PluginPanelBagV1,
  type PluginPanelSourceV1,
  type PluginPanelTabV1,
} from "./panels.js";
import {
  readBotPluginRosterV1,
  withPluginWorkerV1,
  type BotPluginRosterV1,
} from "./worker-bot.js";
import { PLUGIN_VIEW_DEADLINE_MS } from "./views-bot.js";

const IDENTIFIER = { type: "string", maxLength: 128 } as const;

/** The canvas's one read: the bag, the doors, and the focused page. */
export interface PanelOpenViewV1 {
  schemaVersion: 1;
  bag: PluginPanelTabV1[];
  focus: { pluginId: string | null; surfaceId?: string };
  document?: ViewDocument;
  /**
   * The focused surface when its view names a page (ADR 0036): where the
   * artifact host serves it, and the state its view returned.
   */
  page?: { url: string; state: Record<string, unknown> };
  failure?: string;
  doors: PanelDoorViewV1[];
}

export interface PanelDoorViewV1 {
  pluginId: string;
  label: string;
  opens?: { pluginId: string; surfaceId: string };
  document?: ViewDocument;
  failure?: string;
}

export function panelSourcesFromRosterV1(
  roster: BotPluginRosterV1,
): PluginPanelSourceV1[] {
  const enabled = new Set(roster.enabled);
  const members = roster.members.filter((member) =>
    enabled.has(member.packageId),
  );
  const { order } = pluginMountOrderV1(members);
  return order.map((member) => ({
    pluginId: member.packageId,
    displayName: member.descriptor.displayName,
    views: member.descriptor.views,
  }));
}

export function panelBagFromRosterV1(
  roster: BotPluginRosterV1,
): PluginPanelBagV1 {
  return conversationPanelBagV1(panelSourcesFromRosterV1(roster));
}

export async function readFocusedPanelV1(
  storage: DurableObjectStorage,
): Promise<FocusedPanelV1 | undefined> {
  const stored = await storage.get<unknown>(PANEL_FOCUSED_KEY);
  if (stored === undefined) return undefined;
  try {
    return decodeFocusedPanelV1(stored);
  } catch {
    await storage.delete(PANEL_FOCUSED_KEY);
    return undefined;
  }
}

/**
 * Writes the Session pointer. Unknown or dropped surfaces are an error so the
 * tool can name the tabs this Bot actually has; a stored pointer that later
 * leaves the bag is cleared on read instead.
 */
export async function setFocusedPanelV1(
  storage: DurableObjectStorage,
  bag: readonly PluginPanelTabV1[],
  request: { pluginId: string | null; surfaceId?: string },
  now: Date = new Date(),
): Promise<
  | { status: "applied"; focus: FocusedPanelV1 }
  | { status: "error"; failure: string }
> {
  const resolved = resolvePanelFocusV1(bag, request);
  if (resolved.status === "error") return resolved;
  const focus =
    resolved.status === "closed"
      ? focusedPanelV1(null, undefined, now.toISOString())
      : focusedPanelV1(
          resolved.pluginId,
          resolved.surfaceId,
          now.toISOString(),
        );
  await storage.put(PANEL_FOCUSED_KEY, focus);
  return { status: "applied", focus };
}

function liveFocusV1(
  stored: FocusedPanelV1 | undefined,
  bag: readonly PluginPanelTabV1[],
): FocusedPanelV1 | undefined {
  if (!stored || stored.pluginId === null) return stored;
  const still = bag.some(
    (tab) =>
      tab.pluginId === stored.pluginId && tab.surfaceId === stored.surfaceId,
  );
  return still ? stored : undefined;
}

function pluginToolAction(): ViewDocument["actions"][number] {
  return {
    id: PLUGIN_TOOL_ACTION_ID_V1,
    schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["plugin-tool"] },
        pluginId: IDENTIFIER,
        tool: IDENTIFIER,
        arguments: {
          type: "string",
          maxLength: MAX_PLUGIN_TOOL_ARGUMENTS_BYTES_V1,
        },
      },
      required: ["kind", "pluginId", "tool", "arguments"],
      additionalProperties: false,
    },
  };
}

/**
 * The document id the client scopes a surface's local state by. The wire
 * `Identifier` admits no colon and at most 128 characters; a cut id could only
 * collide for two surfaces of one Plugin sharing a long prefix.
 */
export function panelDocumentIdV1(
  kind: "panel" | "nav",
  pluginId: string,
  surfaceId: string,
): string {
  return `${kind}.${pluginId}.${surfaceId}`.slice(0, 128);
}

/**
 * A page the wire refuses is that surface's failure, said in words, not a
 * failed read that takes every tab and door down with it.
 */
export function surfaceDocumentV1(
  surfaceId: string,
  drawn: BotPluginSectionV1,
  revision: number,
): { document?: ViewDocument; failure?: string } {
  // The sentence wraps a reason already cut to 500, so it can run past the
  // wire's own 500.
  if (!drawn.root) return { failure: drawn.failure?.slice(0, 500) };
  try {
    return {
      document: decodeProtocol("ViewDocument", {
        schemaVersion: 1,
        surfaceId,
        revision,
        root: drawn.root,
        actions: [pluginToolAction()],
      }),
    };
  } catch (error) {
    // The walk already vetted the tree, so this is a host bug, not the
    // Plugin's: say it where the next one will be seen.
    console.error("Plugin panel document refused", surfaceId, error);
    return { failure: "This plugin's view could not be shown." };
  }
}

/** What each wanted surface's view answered, keyed `<pluginId>:<surfaceId>`. */
async function renderSurfacesV1(
  state: ShellBotStateV1,
  identity: BotIdentity,
  roster: BotPluginRosterV1,
  wanted: { pluginId: string; surfaceId: string }[],
): Promise<Map<string, PluginWorkerViewResultV1>> {
  const answered = new Map<string, PluginWorkerViewResultV1>();
  if (wanted.length === 0) return answered;
  const members = new Map(
    roster.members.map((member) => [member.packageId, member]),
  );
  const runId = `panels:${identity.botId}`;
  const drop = (reason: string): PluginWorkerViewResultV1 => ({
    schemaVersion: 1,
    status: "drop",
    reason,
  });
  const outcome = await withPluginWorkerV1(
    state,
    identity,
    roster,
    { runId, deadlineMs: PLUGIN_VIEW_DEADLINE_MS },
    async (worker) => {
      await Promise.all(
        wanted.map(async (item) => {
          const key = surfaceKeyV1(item.pluginId, item.surfaceId);
          const failure = worker.failures.find(
            (candidate) => candidate.pluginId === item.pluginId,
          );
          if (failure || !members.has(item.pluginId)) {
            answered.set(
              key,
              drop(failure?.message ?? "this plugin is not mounted"),
            );
            return;
          }
          answered.set(
            key,
            await worker.active.renderView({
              schemaVersion: 1,
              pluginId: item.pluginId,
              surfaceId: item.surfaceId,
              botId: identity.botId,
              sessionId: `${identity.userId}:${identity.botId}`,
              runId,
              turnId: runId,
              generationId: roster.generationId,
              deadlineMs: PLUGIN_VIEW_DEADLINE_MS,
            }),
          );
        }),
      );
      return undefined;
    },
  );
  if (outcome && outcome.status === "unavailable") {
    for (const item of wanted) {
      answered.set(
        surfaceKeyV1(item.pluginId, item.surfaceId),
        drop(outcome.reason),
      );
    }
  }
  return answered;
}

function surfaceKeyV1(pluginId: string, surfaceId: string): string {
  return `${pluginId}:${surfaceId}`;
}

function toolsOfV1(roster: BotPluginRosterV1, pluginId: string): string[] {
  return (
    roster.members
      .find((member) => member.packageId === pluginId)
      ?.descriptor.tools.map((tool) => tool.name) ?? []
  );
}

/**
 * The focused surface's page, when its view names one: where the app serves
 * the stored page, and the state the view returned.
 */
export function focusedPanelPageV1(
  roster: BotPluginRosterV1,
  focused: { pluginId: string; surfaceId: string },
  answer: PluginWorkerViewResultV1 | undefined,
  appOrigin: string,
): { page?: PanelOpenViewV1["page"]; failure?: string } | undefined {
  const member = roster.members.find(
    (candidate) => candidate.packageId === focused.pluginId,
  );
  const path = member?.descriptor.views?.find(
    (view) =>
      view.slot === "conversation.panel" &&
      view.surfaceId === focused.surfaceId,
  )?.page;
  if (!member || path === undefined) return undefined;
  const stored = member.pages?.find((page) => page.path === path);
  if (!stored) return { failure: "This plugin's page was not published." };
  if (!answer || answer.status === "drop") {
    return {
      failure: `This plugin could not show its page${answer?.reason ? `: ${answer.reason.slice(0, 400)}` : "."}`,
    };
  }
  const state = pluginPageStateV1(answer.document);
  if ("failure" in state) {
    return {
      failure: `This plugin's page could not be shown: ${state.failure}.`,
    };
  }
  return {
    page: {
      url: pluginPageUrlV1(appOrigin, stored.contentHash),
      state: state.state,
    },
  };
}

function doorViewV1(
  door: PluginNavDoorV1,
  roster: BotPluginRosterV1,
  answered: Map<string, PluginWorkerViewResultV1>,
  revision: number,
): PanelDoorViewV1 {
  const view: PanelDoorViewV1 = {
    pluginId: door.pluginId,
    label: door.label,
    ...(door.opens ? { opens: door.opens } : {}),
  };
  if (!door.surfaceId) return view;
  const answer = answered.get(surfaceKeyV1(door.pluginId, door.surfaceId));
  if (!answer) return view;
  const document = surfaceDocumentV1(
    panelDocumentIdV1("nav", door.pluginId, door.surfaceId),
    pluginSectionV1(
      {
        pluginId: door.pluginId,
        surfaceId: door.surfaceId,
        tools: toolsOfV1(roster, door.pluginId),
      },
      answer,
    ),
    revision,
  );
  if (document.document) view.document = document.document;
  if (document.failure) view.failure = document.failure;
  return view;
}

/**
 * The canvas read: bag, doors, and the focused page. A pointer whose surface
 * has left the bag is dropped and the stored record is cleared.
 */
export async function openFocusedPanelV1(
  state: ShellBotStateV1,
  identity: BotIdentity,
  /** The app origin the canvas read arrived on, which serves the pages. */
  appOrigin: string,
): Promise<PanelOpenViewV1> {
  const roster = await readBotPluginRosterV1(state, identity);
  const sources = panelSourcesFromRosterV1(roster);
  const bag = conversationPanelBagV1(sources);
  const stored = liveFocusV1(
    await readFocusedPanelV1(state.ctx.storage),
    bag.tabs,
  );
  if (
    stored === undefined &&
    (await state.ctx.storage.get(PANEL_FOCUSED_KEY)) !== undefined
  ) {
    await state.ctx.storage.delete(PANEL_FOCUSED_KEY);
  }
  const doors = botNavDoorsV1(sources, bag.tabs);
  const wanted: { pluginId: string; surfaceId: string }[] = [];
  if (stored?.pluginId && stored.surfaceId) {
    wanted.push({ pluginId: stored.pluginId, surfaceId: stored.surfaceId });
  }
  for (const door of doors) {
    if (door.surfaceId) {
      wanted.push({ pluginId: door.pluginId, surfaceId: door.surfaceId });
    }
  }
  const answered = await renderSurfacesV1(state, identity, roster, wanted);
  const revision = Date.parse(stored?.changedAt ?? "0") || 0;
  const opened: PanelOpenViewV1 = {
    schemaVersion: 1,
    bag: bag.tabs,
    focus: stored
      ? {
          pluginId: stored.pluginId,
          ...(stored.surfaceId ? { surfaceId: stored.surfaceId } : {}),
        }
      : { pluginId: null },
    doors: doors.map((door) => doorViewV1(door, roster, answered, revision)),
  };
  if (stored?.pluginId && stored.surfaceId) {
    const focused = { pluginId: stored.pluginId, surfaceId: stored.surfaceId };
    const answer = answered.get(
      surfaceKeyV1(focused.pluginId, focused.surfaceId),
    );
    const page = focusedPanelPageV1(roster, focused, answer, appOrigin);
    if (page) {
      if (page.page) opened.page = page.page;
      if (page.failure) opened.failure = page.failure.slice(0, 500);
    } else if (answer) {
      const document = surfaceDocumentV1(
        panelDocumentIdV1("panel", focused.pluginId, focused.surfaceId),
        pluginPageV1(
          {
            ...focused,
            tools: toolsOfV1(roster, focused.pluginId),
          },
          answer,
        ),
        revision,
      );
      if (document.document) opened.document = document.document;
      if (document.failure) opened.failure = document.failure;
    }
  }
  return opened;
}

export async function applyPanelFocusV1(
  state: ShellBotStateV1,
  identity: BotIdentity,
  request: { pluginId: string | null; surfaceId?: string },
): Promise<
  | { status: "applied"; focus: FocusedPanelV1 }
  | { status: "error"; failure: string }
> {
  const roster = await readBotPluginRosterV1(state, identity);
  return setFocusedPanelV1(
    state.ctx.storage,
    panelBagFromRosterV1(roster).tabs,
    request,
  );
}

/** Notices for extra panel views the cap dropped, keyed by Plugin. */
export function omittedPanelNoticesV1(
  roster: BotPluginRosterV1,
): Map<string, string> {
  const notices = new Map<string, string>();
  for (const [pluginId, names] of panelBagFromRosterV1(roster).omitted) {
    const copy = omittedPanelsCopyV1(names);
    if (copy) notices.set(pluginId, copy);
  }
  return notices;
}
