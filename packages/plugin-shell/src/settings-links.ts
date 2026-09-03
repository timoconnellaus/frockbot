/**
 * The settings deep-link scheme.
 *
 * GrokBot's harness may cite a settings row by anchor — `app-ui.md` enumerates
 * every linkable anchor and instructs the agent never to invent one (register
 * row 50). FrockBot copies the property, not the custom protocol: the hosted
 * WebUI is the product UI, so a citable settings row is an ordinary URL of the
 * application the User already has open.
 *
 *     <origin>/?bot=<botId>&settings=<surface>#<anchor>
 *
 * `bot` is the shell's existing Bot selector, already read by the Flock client
 * and written by every selection. `settings` names a registered client surface
 * or the default Bot panel, and the fragment names one row inside it. Every part is optional in the
 * decode and refused when unknown: a link that names a surface nobody
 * registered, or an anchor this build does not ship, decodes to `undefined`
 * rather than opening the wrong thing. That is the whole point of holding the
 * anchors in one table — a Bot may cite a link, and cannot invent one.
 *
 * The module is deliberately free of Vue and of every client type, so a
 * backend Contribution rendering an error message or a `send_to_user` payload
 * can cite the same anchors the panel renders.
 */

/** A client surface a settings link may open. */
export type SettingsSurfaceIdV1 =
  | "bot-settings"
  | "bot-panel"
  | "user-settings"
  | "plugins"
  | "models"
  | "connections";

export const SETTINGS_SURFACE_IDS_V1: readonly SettingsSurfaceIdV1[] = [
  "bot-settings",
  "bot-panel",
  "user-settings",
  "plugins",
  "models",
  "connections",
];

/** One linkable row or section. */
export interface SettingsAnchorV1 {
  /** The fragment identifier, and the DOM id of the row it names. */
  anchor: string;
  /** The surface that has to be open for the row to exist. */
  surface: SettingsSurfaceIdV1;
  /** What the row is called on screen; used as the link text. */
  label: string;
  /**
   * `bot` rows only exist for a selected Bot, so their links carry `bot=`.
   * `user` rows are the same for every Bot.
   */
  scope: "bot" | "user";
}

/**
 * Every anchor this build ships. A row absent here has no link, and a link
 * naming an anchor absent here does not resolve — GrokBot's `app-ui.md` makes
 * the same promise ("rows can be absent per account, build and state").
 */
export const SETTINGS_ANCHORS_V1: readonly SettingsAnchorV1[] = [
  // The Bot settings panel, row by row.
  {
    anchor: "bot-avatar",
    surface: "bot-settings",
    label: "Avatar",
    scope: "bot",
  },
  { anchor: "bot-name", surface: "bot-settings", label: "Name", scope: "bot" },
  {
    anchor: "bot-title",
    surface: "bot-settings",
    label: "Title",
    scope: "bot",
  },
  {
    anchor: "bot-label",
    surface: "bot-settings",
    label: "Label",
    scope: "bot",
  },
  {
    anchor: "bot-description",
    surface: "bot-settings",
    label: "Description",
    scope: "bot",
  },
  {
    anchor: "bot-notifications",
    surface: "bot-settings",
    label: "Notifications",
    scope: "bot",
  },
  {
    anchor: "bot-hidden-from-sidebar",
    surface: "bot-settings",
    label: "Hidden from sidebar",
    scope: "bot",
  },
  {
    // Present only while something is waiting: a pending decision is state,
    // not a permanent row, and `app-ui.md`'s own promise is that a row "can be
    // absent per account, build and state".
    anchor: "bot-approvals",
    surface: "bot-settings",
    label: "Waiting on you",
    scope: "bot",
  },
  {
    anchor: "bot-routines",
    surface: "bot-settings",
    label: "Routines",
    scope: "bot",
  },
  {
    anchor: "bot-audit",
    surface: "bot-settings",
    label: "Audit log",
    scope: "bot",
  },

  // Former info-pane anchors keep working at their new homes.
  {
    anchor: "bot-info-identity",
    surface: "bot-settings",
    label: "Identity",
    scope: "bot",
  },
  {
    anchor: "bot-info-members",
    surface: "bot-settings",
    label: "Members",
    scope: "bot",
  },
  {
    anchor: "bot-info-computer",
    surface: "bot-panel",
    label: "Computer",
    scope: "bot",
  },
  {
    anchor: "bot-info-routines",
    surface: "bot-panel",
    label: "Routines",
    scope: "bot",
  },
  {
    anchor: "bot-info-notifications",
    surface: "bot-settings",
    label: "Notifications",
    scope: "bot",
  },

  // Application settings, the Plugins catalog, and the two configuration
  // surfaces that own what a Package declares: Models and Connections.
  {
    anchor: "user-profile",
    surface: "user-settings",
    label: "Your profile",
    scope: "user",
  },
  {
    anchor: "user-package-settings",
    surface: "user-settings",
    label: "Package settings",
    scope: "user",
  },
  {
    anchor: "user-default-model",
    surface: "models",
    label: "Default model",
    scope: "user",
  },
  {
    anchor: "user-model-providers",
    surface: "models",
    label: "Model providers",
    scope: "user",
  },
  {
    anchor: "user-connections",
    surface: "connections",
    label: "Connectors",
    scope: "user",
  },
  {
    anchor: "user-machines",
    surface: "user-settings",
    label: "Registered machines",
    scope: "user",
  },
  {
    anchor: "user-packages",
    surface: "plugins",
    label: "Packages",
    scope: "user",
  },
];

const anchorsByName = new Map(
  SETTINGS_ANCHORS_V1.map((entry) => [entry.anchor, entry]),
);

/** The anchor record, or `undefined` for one this build does not ship. */
export function settingsAnchorV1(anchor: string): SettingsAnchorV1 | undefined {
  return anchorsByName.get(anchor);
}

export interface SettingsLinkTargetV1 {
  surface: SettingsSurfaceIdV1;
  /** Absent when the link names a surface but no row inside it. */
  anchor?: string;
  /** The Bot the link is about, when it names one. */
  botId?: string;
}

export interface SettingsLinkInputV1 {
  anchor: string;
  botId?: string;
  /** Defaults to a relative link, which is what the running client wants. */
  origin?: string;
}

/**
 * Render a link to one settings row. Throws for an unknown anchor: the caller
 * is a Package citing a row, and a citation that resolves to nothing is worse
 * than a missing one.
 */
export function settingsLinkV1(input: SettingsLinkInputV1): string {
  const entry = settingsAnchorV1(input.anchor);
  if (!entry) throw new Error(`unknown settings anchor: ${input.anchor}`);
  const parameters = new URLSearchParams();
  if (entry.scope === "bot" && input.botId) parameters.set("bot", input.botId);
  parameters.set("settings", entry.surface);
  const path = `/?${parameters.toString()}#${entry.anchor}`;
  if (!input.origin) return path;
  return new URL(path, input.origin).href;
}

/** A Markdown link a send payload or an error message can carry verbatim. */
export function renderSettingsLinkV1(input: SettingsLinkInputV1): string {
  const entry = settingsAnchorV1(input.anchor);
  if (!entry) throw new Error(`unknown settings anchor: ${input.anchor}`);
  return `[${entry.label}](${settingsLinkV1(input)})`;
}

function surfaceId(value: string | null): SettingsSurfaceIdV1 | undefined {
  return SETTINGS_SURFACE_IDS_V1.find((candidate) => candidate === value);
}

/**
 * Read a settings link. Accepts an absolute URL or the `?query#fragment` a
 * browser's `location` carries, and returns `undefined` for anything that does
 * not name a surface this build ships.
 *
 * A fragment naming an anchor that belongs to another surface is dropped
 * rather than honoured: opening `bot-settings` and then scrolling to a row that
 * only exists in another panel would leave the User looking at nothing.
 */
export function decodeSettingsLinkV1(
  href: string,
): SettingsLinkTargetV1 | undefined {
  const url = URL.parse(href) ?? URL.parse(href, "http://frockbot.invalid/");
  if (!url) return undefined;
  const surface = surfaceId(url.searchParams.get("settings"));
  if (!surface) return undefined;
  const fragment = decodeURIComponent(url.hash.replace(/^#/u, ""));
  const entry = fragment ? settingsAnchorV1(fragment) : undefined;
  const botId = url.searchParams.get("bot") ?? undefined;
  /*
   * A fragment naming a row that lives somewhere else is still a request for
   * that row, so the anchor decides which surface opens. Dropping it instead
   * is what made `?settings=bot-panel#bot-routines` open the panel and then
   * sit there: a link that resolves to nothing visible reads as a broken app,
   * and a row moving between surfaces is exactly what these links have to
   * survive. A fragment nobody registered still opens the named surface with
   * no row.
   */
  return {
    surface: entry ? entry.surface : surface,
    ...(entry ? { anchor: entry.anchor } : {}),
    ...(botId ? { botId } : {}),
  };
}
