import {
  APPLET_ID_V1,
  type AppletBuildViewV1,
  type AppletSummaryV1,
} from "./applets.js";

/** Versioned, deliberately tiny postMessage seam for sandboxed Package pages. */
export const PACKAGE_IFRAME_BRIDGE_VERSION = 2 as const;

/**
 * The bridge a page speaks.
 *
 * Version 1 is `init`, `state`, `callTool` and `resize`. Version 2 adds the
 * `applets` state feed and the `hello`, `focus` and `openExternal` page
 * messages. A page announces its version with `hello`; a page that never does
 * is a v1 page and only ever receives `schemaVersion: 1` messages, so a page
 * published against v1 keeps working with no change.
 */
export type PackageIframeBridgeVersionV2 = 1 | 2;

export type PackageIframeHostMessageV2 =
  | {
      schemaVersion: PackageIframeBridgeVersionV2;
      type: "init";
      themeTokens: Record<string, string>;
      packageId: string;
      botId: string;
      slot: string;
      /** Manifest v5: which of the Package's pages this frame is showing. */
      pageId?: string;
    }
  | {
      schemaVersion: PackageIframeBridgeVersionV2;
      type: "state";
      name: string;
      value: unknown;
    };

export type PackageIframePageMessageV2 =
  | {
      schemaVersion: PackageIframeBridgeVersionV2;
      type: "callTool";
      name: string;
      input: unknown;
    }
  | {
      schemaVersion: PackageIframeBridgeVersionV2;
      type: "resize";
      height: number;
    }
  /** v2: the page announcing which bridge it speaks, once, on load. */
  | {
      schemaVersion: 2;
      type: "hello";
      bridgeVersion: PackageIframeBridgeVersionV2;
    }
  /**
   * v2: focus one Applet for this Session, or clear the focus. Allowed only
   * for a page of the Package that declares the Applet focus tool; the host
   * gates on that declaration and the backend gates the route again.
   */
  | {
      schemaVersion: 2;
      type: "focus";
      appletId: string | null;
    }
  /** v2: open a URL on the Package artifact origin in a new tab. */
  | {
      schemaVersion: 2;
      type: "openExternal";
      url: string;
    };

/** The tool a Package declares before its pages may change the focused Applet. */
export const PACKAGE_IFRAME_FOCUS_TOOL_V2 = "applet_focus";

/** The host state name that carries the Applets feed to a v2 page. */
export const PACKAGE_IFRAME_APPLETS_STATE_V2 = "applets";

/**
 * What a v2 page receives on the `applets` state.
 *
 * The viewer credential is short-lived and scoped to one Applet generation, so
 * a page holding one past its expiry reconnects; nothing here is durable
 * state, and nothing here is an authority.
 */
export interface PackageIframeAppletsStateV2 {
  focused: AppletSummaryV1 | null;
  list: AppletSummaryV1[];
  viewer: {
    token: string;
    socketUrl: string;
    uiUrl: string;
    generationId: string;
  } | null;
  /**
   * The last check or build outcome. The source itself is not on the feed:
   * the shell renders the code view natively, and a source tree is far larger
   * than the 64 KB a bridge message may carry.
   */
  build?: AppletBuildViewV1;
}

/** The only entry slot in this slice. */
export const PACKAGE_IFRAME_ENTRY_SLOT_V1 = "frockbot.sidebar-actions";

/** Page and entry ids share one shape; both are Package-scoped. */
export const PACKAGE_IFRAME_ID_V1 = /^[a-z][a-z0-9-]{0,31}$/;

export const PACKAGE_IFRAME_MAX_PAGES_V1 = 8;
export const PACKAGE_IFRAME_MAX_ENTRIES_V1 = 4;
export const PACKAGE_IFRAME_ENTRY_LABEL_MAX_V1 = 32;

/**
 * The one slot rule for an iframe page mount, shared by the manifest decoder,
 * the catalog decoder, and the `package_author` input decoder. A slot a
 * Package could not declare in its manifest must not reach a host through any
 * other seam, so there is exactly one predicate rather than three allowlists.
 */
export function iframePageSlotAllowedV1(
  slot: string,
  context: { declaredTools: readonly string[]; pageIds: readonly string[] },
): boolean {
  if (slot === "frockbot.bot-settings-sections") return true;
  if (slot === "frockbot.right-panel") return true;
  const toolResult = "frockbot.tool-result:";
  if (slot.startsWith(toolResult)) {
    return context.declaredTools.includes(slot.slice(toolResult.length));
  }
  const surface = "frockbot.surface:";
  if (slot.startsWith(surface)) {
    return context.pageIds.includes(slot.slice(surface.length));
  }
  return false;
}

export interface PackageIframeArtifactViewV1 {
  contentHash: string;
  size: number;
  mediaType: "text/html";
  bundlerVersion: string;
}

export interface PackageIframePageViewV1 {
  id: string;
  artifact: PackageIframeArtifactViewV1;
  mounts: Array<{ slot: string; order?: number }>;
}

export interface PackageIframeEntryViewV1 {
  id: string;
  slot: "frockbot.sidebar-actions";
  order?: number;
  label: string;
  icon: string;
  opens: { kind: "surface"; page: string };
}

export type PackageIframeProvenanceV1 =
  "Bot-authored" | "User-installed" | "FrockBot";

export const PACKAGE_IFRAME_PROVENANCES_V1: readonly PackageIframeProvenanceV1[] =
  ["Bot-authored", "User-installed", "FrockBot"];

export interface PackageIframeContributionViewV1 {
  packageId: string;
  displayName: string;
  /** How the shell attributes the page. `FrockBot` is a first-party
   * artifact-backed member (ADR 0022 decision 8): shipped by FrockBot, loaded
   * through the same path as a Bot-authored Package. */
  provenance: PackageIframeProvenanceV1;
  /** Manifest v5: 1..8 pages. A v3/v4 single-page record migrates to one. */
  pages: PackageIframePageViewV1[];
  entries: PackageIframeEntryViewV1[];
  declaredTools: string[];
}

export interface PackageIframeCompositionV1 {
  schemaVersion: 1;
  botId: string;
  generationId: string;
  contributions: PackageIframeContributionViewV1[];
}

export interface PackageIframeCatalogV1 extends PackageIframeCompositionV1 {
  /** Separate, anonymous serving origin; artifact paths are appended by the host. */
  artifactOrigin: string;
}

export interface PackageIframeToolCommandV1 {
  schemaVersion: 1;
  commandId: string;
  generationId: string;
  packageId: string;
  name: string;
  input: unknown;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(
  value: Record<string, unknown>,
  fields: readonly string[],
  label: string,
): void {
  if (
    Object.keys(value).length !== fields.length ||
    !fields.every((field) => Object.hasOwn(value, field))
  ) {
    throw new Error(`${label} has invalid fields`);
  }
}

function boundedString(value: unknown, label: string, maximum = 256): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum
  ) {
    throw new Error(`${label} must be a bounded non-empty string`);
  }
  return value;
}

function json(value: unknown, label: string, depth = 0): void {
  if (depth > 16) throw new Error(`${label} is too deeply nested`);
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return;
  if (Array.isArray(value)) {
    if (value.length > 256) throw new Error(`${label} has too many entries`);
    for (const entry of value) json(entry, label, depth + 1);
    return;
  }
  const object = record(value, label);
  if (Object.keys(object).length > 256)
    throw new Error(`${label} has too many fields`);
  for (const entry of Object.values(object)) json(entry, label, depth + 1);
}

function boundedJsonWire(value: unknown, label: string): void {
  let wire: string | undefined;
  try {
    wire = JSON.stringify(value);
  } catch {
    throw new Error(`${label} must contain only acyclic JSON`);
  }
  if (wire === undefined) throw new Error(`${label} must contain JSON`);
  if (new TextEncoder().encode(wire).byteLength > 64 * 1024) {
    throw new Error(`${label} exceeds the wire byte limit`);
  }
}

/**
 * Exact host-side decoder; unknown message types and fields fail closed.
 *
 * Both bridge versions decode here: a v1 page's messages keep their
 * `schemaVersion: 1`, and the three v2-only messages are refused at v1 rather
 * than silently accepted, so a page cannot reach a v2 capability by claiming
 * the older version.
 */
export function decodePackageIframePageMessageV2(
  input: unknown,
): PackageIframePageMessageV2 {
  const value = record(input, "Package iframe message");
  boundedJsonWire(input, "Package iframe message");
  if (value.schemaVersion !== 1 && value.schemaVersion !== 2)
    throw new Error("Package iframe schemaVersion is unsupported");
  const schemaVersion = value.schemaVersion as PackageIframeBridgeVersionV2;
  if (value.type === "callTool") {
    exact(
      value,
      ["schemaVersion", "type", "name", "input"],
      "Package iframe callTool",
    );
    const name = boundedString(value.name, "Package iframe callTool.name", 64);
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(name))
      throw new Error("Package iframe tool name is invalid");
    json(value.input, "Package iframe callTool.input");
    return {
      schemaVersion,
      type: "callTool",
      name,
      input: structuredClone(value.input),
    };
  }
  if (value.type === "resize") {
    exact(value, ["schemaVersion", "type", "height"], "Package iframe resize");
    if (typeof value.height !== "number" || !Number.isFinite(value.height)) {
      throw new Error("Package iframe resize.height must be finite");
    }
    return { schemaVersion, type: "resize", height: value.height };
  }
  if (schemaVersion === 2 && value.type === "hello") {
    exact(
      value,
      ["schemaVersion", "type", "bridgeVersion"],
      "Package iframe hello",
    );
    if (value.bridgeVersion !== 1 && value.bridgeVersion !== 2) {
      throw new Error("Package iframe hello.bridgeVersion is unsupported");
    }
    return {
      schemaVersion: 2,
      type: "hello",
      bridgeVersion: value.bridgeVersion as PackageIframeBridgeVersionV2,
    };
  }
  if (schemaVersion === 2 && value.type === "focus") {
    exact(value, ["schemaVersion", "type", "appletId"], "Package iframe focus");
    if (value.appletId === null) {
      return { schemaVersion: 2, type: "focus", appletId: null };
    }
    const appletId = boundedString(
      value.appletId,
      "Package iframe focus.appletId",
      129,
    );
    if (!APPLET_ID_V1.test(appletId)) {
      throw new Error("Package iframe focus.appletId is invalid");
    }
    return { schemaVersion: 2, type: "focus", appletId };
  }
  if (schemaVersion === 2 && value.type === "openExternal") {
    exact(
      value,
      ["schemaVersion", "type", "url"],
      "Package iframe openExternal",
    );
    const url = boundedString(
      value.url,
      "Package iframe openExternal.url",
      2_048,
    );
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("Package iframe openExternal.url is invalid");
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("Package iframe openExternal.url is invalid");
    }
    return { schemaVersion: 2, type: "openExternal", url };
  }
  throw new Error("Package iframe message type is invalid");
}

/**
 * The one origin a page may hand the host to open. A page is served from the
 * anonymous artifact origin and has no business steering the User anywhere
 * else, so anything other than that origin is refused rather than sanitized.
 */
export function packageIframeExternalUrlAllowedV2(
  url: string,
  artifactOrigin: string,
): boolean {
  try {
    return new URL(url).origin === new URL(artifactOrigin).origin;
  } catch {
    return false;
  }
}

/**
 * Whether a page of this Package may change the Session's focused Applet.
 * Focus is an Applet capability, so it belongs to the Package that owns the
 * Applet tools and to no other.
 */
export function packageIframeFocusAllowedV2(
  contribution: Pick<PackageIframeContributionViewV1, "declaredTools">,
): boolean {
  return contribution.declaredTools.includes(PACKAGE_IFRAME_FOCUS_TOOL_V2);
}

export function decodePackageIframeToolCommandV1(
  input: unknown,
): PackageIframeToolCommandV1 {
  const value = record(input, "Package iframe tool command");
  boundedJsonWire(input, "Package iframe tool command");
  exact(
    value,
    [
      "schemaVersion",
      "commandId",
      "generationId",
      "packageId",
      "name",
      "input",
    ],
    "Package iframe tool command",
  );
  if (value.schemaVersion !== 1)
    throw new Error("Package iframe tool command version is unsupported");
  const name = boundedString(
    value.name,
    "Package iframe tool command.name",
    64,
  );
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(name))
    throw new Error("Package iframe tool command name is invalid");
  json(value.input, "Package iframe tool command.input");
  return {
    schemaVersion: 1,
    commandId: boundedString(
      value.commandId,
      "Package iframe tool command.commandId",
    ),
    generationId: boundedString(
      value.generationId,
      "Package iframe tool command.generationId",
    ),
    packageId: boundedString(
      value.packageId,
      "Package iframe tool command.packageId",
      64,
    ),
    name,
    input: structuredClone(value.input),
  };
}

export function packageIframeToolAllowedV1(
  contribution: Pick<PackageIframeContributionViewV1, "declaredTools">,
  name: string,
): boolean {
  return contribution.declaredTools.includes(name);
}

export function decodePackageIframeCatalogV1(
  input: unknown,
): PackageIframeCatalogV1 {
  const value = record(input, "Package iframe catalog");
  exact(
    value,
    [
      "schemaVersion",
      "botId",
      "generationId",
      "artifactOrigin",
      "contributions",
    ],
    "Package iframe catalog",
  );
  if (value.schemaVersion !== 1)
    throw new Error("Package iframe catalog version is unsupported");
  const artifactOrigin = boundedString(
    value.artifactOrigin,
    "Package iframe artifactOrigin",
    2_048,
  );
  const origin = new URL(artifactOrigin);
  if (
    origin.origin !== artifactOrigin ||
    !["http:", "https:"].includes(origin.protocol)
  ) {
    throw new Error("Package iframe artifactOrigin is invalid");
  }
  if (!Array.isArray(value.contributions) || value.contributions.length > 64) {
    throw new Error("Package iframe contributions must be a bounded array");
  }
  const contributions = value.contributions.map((candidate, index) => {
    const label = `Package iframe contributions[${index}]`;
    const contribution = record(candidate, label);
    exact(
      contribution,
      [
        "packageId",
        "displayName",
        "provenance",
        "pages",
        "entries",
        "declaredTools",
      ],
      label,
    );
    if (
      !Array.isArray(contribution.declaredTools) ||
      contribution.declaredTools.length > 64
    ) {
      throw new Error(`${label}.declaredTools must be a bounded array`);
    }
    const declaredTools = contribution.declaredTools.map((tool, toolIndex) =>
      boundedString(tool, `${label}.declaredTools[${toolIndex}]`, 64),
    );
    if (
      !Array.isArray(contribution.pages) ||
      contribution.pages.length === 0 ||
      contribution.pages.length > PACKAGE_IFRAME_MAX_PAGES_V1
    ) {
      throw new Error(`${label}.pages must be a non-empty bounded array`);
    }
    const pageIds = contribution.pages.map((candidatePage, pageIndex) => {
      const page = record(candidatePage, `${label}.pages[${pageIndex}]`);
      const id = boundedString(page.id, `${label}.pages[${pageIndex}].id`, 32);
      if (!PACKAGE_IFRAME_ID_V1.test(id)) {
        throw new Error(`${label}.pages[${pageIndex}].id is invalid`);
      }
      return id;
    });
    if (new Set(pageIds).size !== pageIds.length) {
      throw new Error(`${label}.pages contains duplicate ids`);
    }
    const pages = contribution.pages.map((candidatePage, pageIndex) => {
      const pageLabel = `${label}.pages[${pageIndex}]`;
      const page = record(candidatePage, pageLabel);
      exact(page, ["id", "artifact", "mounts"], pageLabel);
      const artifact = record(page.artifact, `${pageLabel}.artifact`);
      exact(
        artifact,
        ["contentHash", "size", "mediaType", "bundlerVersion"],
        `${pageLabel}.artifact`,
      );
      if (
        typeof artifact.contentHash !== "string" ||
        !/^[0-9a-f]{64}$/.test(artifact.contentHash)
      ) {
        throw new Error(`${pageLabel}.artifact.contentHash is invalid`);
      }
      if (
        !Number.isSafeInteger(artifact.size) ||
        (artifact.size as number) < 0 ||
        (artifact.size as number) > 256 * 1024 ||
        artifact.mediaType !== "text/html"
      ) {
        throw new Error(`${pageLabel}.artifact metadata is invalid`);
      }
      if (
        !Array.isArray(page.mounts) ||
        page.mounts.length === 0 ||
        page.mounts.length > 64
      ) {
        throw new Error(
          `${pageLabel}.mounts must be a non-empty bounded array`,
        );
      }
      const mounts = page.mounts.map((candidateMount, mountIndex) => {
        const mount = record(
          candidateMount,
          `${pageLabel}.mounts[${mountIndex}]`,
        );
        const hasOrder = mount.order !== undefined;
        exact(
          mount,
          hasOrder ? ["slot", "order"] : ["slot"],
          `${pageLabel}.mounts[${mountIndex}]`,
        );
        if (
          hasOrder &&
          (typeof mount.order !== "number" || !Number.isFinite(mount.order))
        ) {
          throw new Error(
            `${pageLabel}.mounts[${mountIndex}].order is invalid`,
          );
        }
        const slot = boundedString(
          mount.slot,
          `${pageLabel}.mounts[${mountIndex}].slot`,
          160,
        );
        if (!iframePageSlotAllowedV1(slot, { declaredTools, pageIds })) {
          throw new Error(`${pageLabel}.mounts contains an unsafe slot`);
        }
        return { slot, ...(hasOrder ? { order: mount.order as number } : {}) };
      });
      return {
        id: pageIds[pageIndex]!,
        artifact: {
          contentHash: artifact.contentHash,
          size: artifact.size as number,
          mediaType: "text/html" as const,
          bundlerVersion: boundedString(
            artifact.bundlerVersion,
            `${pageLabel}.artifact.bundlerVersion`,
            128,
          ),
        },
        mounts,
      };
    });
    if (
      !Array.isArray(contribution.entries) ||
      contribution.entries.length > PACKAGE_IFRAME_MAX_ENTRIES_V1
    ) {
      throw new Error(`${label}.entries must be a bounded array`);
    }
    const entries = contribution.entries.map((candidateEntry, entryIndex) => {
      const entryLabel = `${label}.entries[${entryIndex}]`;
      const entry = record(candidateEntry, entryLabel);
      const hasOrder = entry.order !== undefined;
      exact(
        entry,
        hasOrder
          ? ["id", "slot", "order", "label", "icon", "opens"]
          : ["id", "slot", "label", "icon", "opens"],
        entryLabel,
      );
      const id = boundedString(entry.id, `${entryLabel}.id`, 32);
      if (!PACKAGE_IFRAME_ID_V1.test(id)) {
        throw new Error(`${entryLabel}.id is invalid`);
      }
      if (entry.slot !== PACKAGE_IFRAME_ENTRY_SLOT_V1) {
        throw new Error(`${entryLabel}.slot is invalid`);
      }
      if (
        hasOrder &&
        (typeof entry.order !== "number" || !Number.isFinite(entry.order))
      ) {
        throw new Error(`${entryLabel}.order is invalid`);
      }
      const opens = record(entry.opens, `${entryLabel}.opens`);
      exact(opens, ["kind", "page"], `${entryLabel}.opens`);
      if (opens.kind !== "surface") {
        throw new Error(`${entryLabel}.opens.kind is invalid`);
      }
      const page = boundedString(opens.page, `${entryLabel}.opens.page`, 32);
      const target = pages.find((candidate) => candidate.id === page);
      if (
        !target ||
        !target.mounts.some(
          (mount) => mount.slot === `frockbot.surface:${page}`,
        )
      ) {
        throw new Error(`${entryLabel}.opens.page names no surface page`);
      }
      return {
        id,
        slot: PACKAGE_IFRAME_ENTRY_SLOT_V1 as "frockbot.sidebar-actions",
        ...(hasOrder ? { order: entry.order as number } : {}),
        label: boundedString(
          entry.label,
          `${entryLabel}.label`,
          PACKAGE_IFRAME_ENTRY_LABEL_MAX_V1,
        ),
        icon: boundedString(entry.icon, `${entryLabel}.icon`, 64),
        opens: { kind: "surface" as const, page },
      };
    });
    if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
      throw new Error(`${label}.entries contains duplicate ids`);
    }
    if (
      !PACKAGE_IFRAME_PROVENANCES_V1.includes(
        contribution.provenance as PackageIframeProvenanceV1,
      )
    ) {
      throw new Error(`${label}.provenance is invalid`);
    }
    return {
      packageId: boundedString(
        contribution.packageId,
        `${label}.packageId`,
        64,
      ),
      displayName: boundedString(
        contribution.displayName,
        `${label}.displayName`,
        128,
      ),
      provenance: contribution.provenance as PackageIframeProvenanceV1,
      pages,
      entries,
      declaredTools,
    };
  });
  if (
    new Set(contributions.map((contribution) => contribution.packageId))
      .size !== contributions.length
  ) {
    throw new Error("Package iframe catalog contains duplicate Packages");
  }
  return {
    schemaVersion: 1,
    botId: boundedString(value.botId, "Package iframe botId"),
    generationId: boundedString(
      value.generationId,
      "Package iframe generationId",
    ),
    artifactOrigin,
    contributions,
  };
}

/** TypeScript contract shown by package_inspect_self. */
export const PACKAGE_IFRAME_BRIDGE_DTS_V1 = `
interface FrockBotAppletSummary { appletId: string; displayName: string; status: "draft" | "published" | "deleted"; currentGenerationId?: string; tools: string[]; createdAt: string }
interface FrockBotAppletsState {
  focused: FrockBotAppletSummary | null;
  list: FrockBotAppletSummary[];
  viewer: { token: string; socketUrl: string; uiUrl: string; generationId: string } | null;
  build?: { status: "unknown" | "passed" | "failed"; command?: "check" | "build"; at?: string; summary?: string; diagnostics?: string[] };
}
interface FrockBotIframeBridgeV2 {
  readonly ready: Promise<{ themeTokens: Record<string, string>; packageId: string; botId: string; slot: string; pageId?: string }>;
  callTool(name: string, input: unknown): void;
  subscribe(name: string, listener: (value: unknown) => void): () => void;
  resize(height?: number): void;
  /** v2. Focus one Applet for this Session, or clear it. Requires the applet_focus tool. */
  focus(appletId: string | null): void;
  /** v2. Open a URL on this Package's artifact origin in a new tab. */
  openExternal(url: string): void;
}
declare global { interface Window { frockbot: FrockBotIframeBridgeV2 } }
// The bridge is version 2. A page announces itself with hello and then
// receives schemaVersion: 2 messages; a page using the version 1 helper keeps
// receiving schemaVersion: 1 messages and works unchanged.
// Results arrive on state name tool:<name>. A page mounted in
// frockbot.right-panel or a surface also receives state name "applets" with
// FrockBotAppletsState.
//
// A Package declares 1..8 UI pages. Each page has an id (/^[a-z][a-z0-9-]{0,31}$/,
// unique in the Package), one inline ui.html, and 1..64 mounts. The slot of a
// mount must be one of:
//   frockbot.bot-settings-sections   the Bot's settings screen
//   frockbot.tool-result:<tool>      under a result of that declared tool
//   frockbot.right-panel             the right-hand panel body
//   frockbot.surface:<pageId>        an overlay surface named by a page id
// A Package may also declare 0..4 entries. An entry is
// { id, slot: "frockbot.sidebar-actions", order?, label (<= 32 chars), icon,
//   opens: { kind: "surface", page } }; \`opens.page\` must name a page that
// mounts frockbot.surface:<that page id>. \`ready\` resolves with the id of the
// page this frame is showing.
`;

/**
 * Tiny inline helper authored pages may paste verbatim.
 *
 * It announces `hello` before anything else, so the host knows this page reads
 * version 2 messages; a page carrying the older helper never announces, and the
 * host keeps speaking version 1 to it.
 */
export const PACKAGE_IFRAME_HELPER_JS_V1 = `(()=>{const V=2,L=new Map(),obj=v=>v&&typeof v==='object'&&!Array.isArray(v),exact=(v,ks)=>obj(v)&&Object.keys(v).length===ks.length&&ks.every(k=>Object.prototype.hasOwnProperty.call(v,k)),str=(v,n)=>typeof v==='string'&&v.length>0&&v.length<=n,json=(v,d=0)=>d<=16&&(v===null||typeof v==='string'||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v)||Array.isArray(v)&&v.length<=256&&v.every(x=>json(x,d+1))||obj(v)&&Object.keys(v).length<=256&&Object.values(v).every(x=>json(x,d+1))),wire=v=>{try{return new TextEncoder().encode(JSON.stringify(v)).byteLength<=65536}catch{return false}};let ok,fail;const ready=new Promise((r,j)=>{ok=r;fail=j});addEventListener('message',e=>{if(e.source!==parent)return;const m=e.data;if(m?.schemaVersion!==1&&m?.schemaVersion!==2||!wire(m))return;if(m.type==='init'&&(exact(m,['schemaVersion','type','themeTokens','packageId','botId','slot'])||exact(m,['schemaVersion','type','themeTokens','packageId','botId','slot','pageId'])&&str(m.pageId,32))&&obj(m.themeTokens)&&Object.keys(m.themeTokens).length<=64&&Object.values(m.themeTokens).every(v=>typeof v==='string')&&str(m.packageId,64)&&str(m.botId,256)&&str(m.slot,160)){for(const [k,v] of Object.entries(m.themeTokens))document.documentElement.style.setProperty('--frockbot-'+k,v);ok({themeTokens:m.themeTokens,packageId:m.packageId,botId:m.botId,slot:m.slot,...(m.pageId===undefined?{}:{pageId:m.pageId})});return}if(m.type==='state'&&exact(m,['schemaVersion','type','name','value'])&&str(m.name,256)&&json(m.value))for(const fn of L.get(m.name)||[])fn(m.value)});window.frockbot={ready,callTool(name,input){parent.postMessage({schemaVersion:V,type:'callTool',name,input},'*')},subscribe(name,fn){const s=L.get(name)||new Set();s.add(fn);L.set(name,s);return()=>s.delete(fn)},resize(height=document.documentElement.scrollHeight){parent.postMessage({schemaVersion:V,type:'resize',height},'*')},focus(appletId){parent.postMessage({schemaVersion:2,type:'focus',appletId:appletId===undefined?null:appletId},'*')},openExternal(url){parent.postMessage({schemaVersion:2,type:'openExternal',url},'*')}};parent.postMessage({schemaVersion:2,type:'hello',bridgeVersion:V},'*');setTimeout(()=>fail(new Error('FrockBot iframe init timed out')),10000)})();`;
