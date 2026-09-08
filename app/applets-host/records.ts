// The Bot Durable Object's half of Applets: `ctx.applets`, and the resolution
// of Applet members into a Bot's Composition.
//
// Two things live here and nothing else does. The **capability** a Bot isolate
// calls — list, create, publish, revert, delete, focus, generations — and the
// **resolution** that turns the User's Applet directory into the `applet`
// members of the Bot's next Composition generation. Both are Bot-scoped
// because they run as one Bot, with exactly that Bot's authority; the directory
// they read and write is the User's, and the instance they mount is the
// kernel's Applet Durable Object.
//
// `publish` is a durable effect, and it is written in the order the
// constitution's rule requires: record intent, then read the source, then
// build, then verify, then the immutable artifact, then the durable records,
// then the mount, then the Composition proposal. A crash anywhere resumes from
// the recorded intent rather than repeating a side effect.
//
// The bytes a publish stores come from the build service, never from a
// Computer: the source prefix is listed and read out of the Workspace store,
// posted to `APPLET_BUILD`, and the artifacts that come back are hash-verified
// against the manifest the service derived by running them.
import {
  appletGenerationIdV1,
  APPLET_CONTRACT_V1,
  APPLET_FOCUSED_KEY,
  decodeFocusedAppletV1,
  type FocusedAppletV1,
} from "@frockbot/core/durable";
import type {
  AppletCapabilityCallScopeV1,
  AppletCapabilityHostV1,
  AppletCheckResultV1,
  AppletSourceFileV1,
} from "@frockbot/applets/feature";
import {
  APPLET_BUILD_LIMITS,
  APPLET_BUILD_PROTOCOL_VERSION,
  type AppletBuildDiagnosticV1,
  type AppletBuildManifestV1,
  type AppletBuildRequestV1,
  type AppletBuildResponseV1,
  type AppletBuildSourceFileV1,
} from "@frockbot/applets/build-contract";
import {
  appletSourceFilePathV1,
  appletSourcePathV1,
  appletsSourceRootV1,
} from "@frockbot/applets/root";
import { appletPreviewUrlV1 } from "@frockbot/applets/preview";
import {
  decodeAppletGenerationV1,
  decodeAppletSummaryV1,
  decodeAppletToolDeclarationV1,
  type AppletGenerationV1,
  type AppletProvenanceV1,
  type AppletPublishResultV1,
  type AppletSummaryV1,
  type AppletToolDeclarationV1,
} from "@frockbot/core/contracts";
import type { WorkspaceFilesV1 } from "@frockbot/core/contracts";
import {
  compositionArtifactSetHashV1,
  compositionGenerationIdV1,
  decodeCompositionGenerationV1,
  pinCompositionWithRetryV1,
  type CompositionAppletMemberV1,
  type CompositionJsonValueV1,
  type CompositionGenerationV1,
  type CompositionStore,
  type PackageProvenanceV1,
} from "@frockbot/core/durable";

/** The durable key one publish intent is recorded under, by effect id. */
export const APPLET_PUBLISH_EFFECT_PREFIX = "applets:publish-effect:";
/**
 * The directory revision the Bot's current Composition generation resolved
 * Applet members at. A revision that no longer matches the User's is the whole
 * of the fan-out signal.
 */
export const APPLET_DIRECTORY_REVISION_SEEN_KEY = "applets:directory-revision";

export interface AppletPublishIntentV1 {
  schemaVersion: 1;
  effectId: string;
  appletId: string;
  botId: string;
  sessionId: string;
  turnId: string;
  runId: string;
  recordedAt: string;
  /** Set once the effect settled, so a retry answers rather than repeats. */
  outcome?: AppletPublishResultV1;
}

/** The User Durable Object's Applet directory, as this Bot reads and writes it. */
export interface AppletUserDirectoryV1 {
  list(): Promise<{ revision: number; applets: AppletSummaryV1[] }>;
  compositionInput(): Promise<{
    revision: number;
    applets: {
      appletId: string;
      generationId: string;
      tools: AppletToolDeclarationV1[];
      provenance: AppletProvenanceV1;
    }[];
  }>;
  create(input: {
    displayName: string;
    provenance: AppletProvenanceV1;
  }): Promise<AppletSummaryV1>;
  recordGeneration(input: {
    appletId: string;
    generationId: string;
    tools: AppletToolDeclarationV1[];
  }): Promise<AppletSummaryV1>;
  delete(appletId: string): Promise<AppletSummaryV1>;
}

/** One Applet instance's Durable Object, as this Bot calls it. */
export interface AppletInstanceBindingV1 {
  publish(input: { appletId: string; generation: AppletGenerationV1 }): Promise<
    | { status: "active"; generationId: string; tools: string[] }
    | {
        status: "failed";
        generationId: string;
        reason: string;
        diagnostics: string[];
      }
  >;
  revert(input: { appletId: string; generation: AppletGenerationV1 }): Promise<
    | { status: "active"; generationId: string; tools: string[] }
    | {
        status: "failed";
        generationId: string;
        reason: string;
        diagnostics: string[];
      }
  >;
  /**
   * `generationId` is the Applet generation the calling Turn pinned. The
   * instance runs that generation or refuses the call.
   */
  invokeTool(input: {
    appletId: string;
    generationId: string;
    tool: string;
    input: unknown;
  }): Promise<{ status: "ok" | "error"; content: string }>;
  read(input: { appletId: string }): Promise<{
    current?: { generationId: string };
    generations: AppletGenerationV1[];
  }>;
}

/** The `APPLET_STATES` binding, as this Package needs to see it. */
export type AppletInstanceNamespaceV1 = DurableObjectNamespace;

/** The Applet Durable Object's RPC surface, addressed by name. */
interface AppletInstanceRpcV1 {
  publish(input: unknown): Promise<unknown>;
  revert(input: unknown): Promise<unknown>;
  invokeTool(input: unknown): Promise<unknown>;
  read(input: unknown): Promise<unknown>;
}

function appletInstanceRpc(
  namespace: AppletInstanceNamespaceV1,
  userId: string,
  appletId: string,
): AppletInstanceRpcV1 {
  const name = `${userId}:${appletId}`;
  // SAFETY: this namespace is bound to the kernel's AppletState class;
  // generated Worker types do not expose its RPC surface.
  return namespace.get(
    namespace.idFromName(name),
  ) as unknown as AppletInstanceRpcV1;
}

function decodeActivation(
  value: unknown,
  label: string,
):
  | { status: "active"; generationId: string; tools: string[] }
  | {
      status: "failed";
      generationId: string;
      reason: string;
      diagnostics: string[];
    } {
  const snapshot = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  if (snapshot?.status === "active") {
    return {
      status: "active",
      generationId: String(snapshot.generationId),
      tools: Array.isArray(snapshot.tools) ? snapshot.tools.map(String) : [],
    };
  }
  if (snapshot?.status === "failed") {
    return {
      status: "failed",
      generationId: String(snapshot.generationId),
      reason: String(snapshot.reason),
      diagnostics: Array.isArray(snapshot.diagnostics)
        ? snapshot.diagnostics.map(String)
        : [],
    };
  }
  throw new Error(`${label} is invalid`);
}

/**
 * One Applet instance over the `APPLET_STATES` namespace. Every answer is
 * snapshotted and decoded on arrival: a Durable Object answer is a live stub
 * until it is, and the exact-keys decoders are right to refuse one.
 */
export function createAppletInstanceBindingV1(
  namespace: AppletInstanceNamespaceV1,
  userId: string,
): (appletId: string) => AppletInstanceBindingV1 {
  return (appletId) => {
    const rpc = appletInstanceRpc(namespace, userId, appletId);
    const envelope = (extra: Record<string, unknown> = {}) => ({
      schemaVersion: 1 as const,
      userId,
      appletId,
      ...extra,
    });
    return {
      async publish(input) {
        return decodeActivation(
          await rpc.publish(envelope({ generation: input.generation })),
          "Applet publish outcome",
        );
      },
      async revert(input) {
        return decodeActivation(
          await rpc.revert(envelope({ generation: input.generation })),
          "Applet revert outcome",
        );
      },
      async invokeTool(input) {
        const answer = JSON.parse(
          JSON.stringify(
            await rpc.invokeTool(
              envelope({
                generationId: input.generationId,
                tool: input.tool,
                toolInput: input.input ?? null,
              }),
            ),
          ),
        ) as { status?: unknown; content?: unknown };
        return {
          status: answer.status === "ok" ? "ok" : "error",
          content: typeof answer.content === "string" ? answer.content : "",
        };
      },
      async read() {
        const answer = JSON.parse(
          JSON.stringify(await rpc.read(envelope())),
        ) as { current?: { generationId?: unknown }; generations?: unknown };
        return {
          ...(answer.current?.generationId
            ? { current: { generationId: String(answer.current.generationId) } }
            : {}),
          generations: Array.isArray(answer.generations)
            ? answer.generations.map((generation) =>
                decodeAppletGenerationV1(generation),
              )
            : [],
        };
      },
    };
  };
}

/** The immutable artifact store, as a publish writes it. */
export interface AppletArtifactSinkV1 {
  putPackageArtifact(contentHash: string, module: string): Promise<void>;
  putPackageUiArtifact(contentHash: string, html: string): Promise<void>;
}

export interface AppletCapabilityStorageV1 {
  get<T>(key: string): Promise<T | undefined>;
  put(entries: Record<string, unknown>): Promise<void>;
}

export interface AppletCapabilityHostOptionsV1 {
  userId: string;
  botId: string;
  storage: AppletCapabilityStorageV1;
  directory: AppletUserDirectoryV1;
  instanceFor(appletId: string): AppletInstanceBindingV1;
  artifacts: AppletArtifactSinkV1;
  /** Applet source, under the Applets Package's declared root. */
  workspace: WorkspaceFilesV1;
  /**
   * The build service, or absent when this deployment has no binding or no
   * token for it. Absent is an ordinary refusal — "the build service is
   * unavailable" — never a thrown error inside a Turn.
   */
  buildService?: AppletBuildServiceV1;
  /**
   * The app's own origin, from which the anonymous artifact origin a preview
   * URL points at is derived. Absent leaves a successful check without one:
   * the tools and the diagnostics are the answer either way.
   */
  appOrigin?: string;
  composition: Pick<CompositionStore, "current" | "lastKnownGood" | "propose">;
  now?(): Date;
}

/**
 * The Applet build service, as this host calls it.
 *
 * The seam is the contract's own request and response, so the Bot Durable
 * Object's wiring is a `fetch` and two decoders and a test's fake is a
 * function.
 */
export interface AppletBuildServiceV1 {
  build(request: AppletBuildRequestV1): Promise<AppletBuildResponseV1>;
}

const TEXT = new TextDecoder();

/**
 * The plain JSON a cross-object RPC answer really is.
 *
 * A Durable Object answer arrives as a live stub carrying `Symbol.dispose` and
 * whatever else the runtime attached, and an exact-keys decoder is right to
 * refuse that. Snapshotting first is what turns the answer into the DTO it
 * claims to be.
 */
export function appletRpcSnapshotV1<T>(value: T): T {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("Applet RPC response is not a JSON value");
  }
  return JSON.parse(serialized) as T;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** The media type Applet source of one path is stored under. */
function sourceMediaType(path: string): string {
  return path.endsWith(".json")
    ? "application/json"
    : "text/plain; charset=utf-8";
}

/** One diagnostic, as the Bot reads it: `path:line:col message`. */
export function appletDiagnosticTextV1(
  diagnostic: AppletBuildDiagnosticV1,
): string {
  return `${diagnostic.file}:${diagnostic.line}:${diagnostic.column} ${diagnostic.message}`;
}

/**
 * The Applet member set one Composition generation records, from the User's
 * directory. Ordered by Applet id, so the artifact set hash is stable.
 */
export function appletCompositionMembersV1(
  applets: readonly {
    appletId: string;
    generationId: string;
    tools: AppletToolDeclarationV1[];
    provenance: AppletProvenanceV1;
  }[],
): CompositionAppletMemberV1[] {
  return [...applets]
    .sort((left, right) => left.appletId.localeCompare(right.appletId))
    .map((applet) => ({
      kind: "applet" as const,
      appletId: applet.appletId,
      generationId: applet.generationId,
      tools: applet.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        // The declaration's schema really is JSON — the tool decoder proved it
        // — but its declared type is `Record<string, unknown>`, which a
        // Durable Object RPC boundary cannot carry. The round trip is the
        // narrowing.
        inputSchema: JSON.parse(JSON.stringify(tool.inputSchema)) as {
          [key: string]: CompositionJsonValueV1;
        },
      })),
      provenance: appletMemberProvenanceV1(applet),
    }));
}

/**
 * An Applet's provenance in the shape the Composition records provenance in.
 * The "package" is the Applet and its "version" is its generation, because a
 * Composition member is identified by what it is and which version of it ran.
 */
export function appletMemberProvenanceV1(applet: {
  appletId: string;
  generationId: string;
  provenance: AppletProvenanceV1;
}): PackageProvenanceV1 {
  if (applet.provenance.kind === "bot") {
    return {
      kind: "bot",
      packageId: applet.appletId,
      version: applet.generationId,
      botId: applet.provenance.botId,
      sessionId: applet.provenance.sessionId,
      turnId: applet.provenance.turnId,
      runId: applet.provenance.turnId,
      authoredAt: new Date(0).toISOString(),
    };
  }
  return {
    kind: "user",
    packageId: applet.appletId,
    version: applet.generationId,
    userId: applet.appletId.slice(0, applet.appletId.lastIndexOf(".")),
    authoredAt: new Date(0).toISOString(),
  };
}

/** True when two Applet member sets differ in identity, generation, or tools. */
export function appletMembersDifferV1(
  left: readonly CompositionAppletMemberV1[],
  right: readonly CompositionAppletMemberV1[],
): boolean {
  if (left.length !== right.length) return true;
  return left.some((member, index) => {
    const other = right[index];
    return (
      !other ||
      other.appletId !== member.appletId ||
      other.generationId !== member.generationId ||
      other.tools.length !== member.tools.length ||
      other.tools.some((tool, at) => tool.name !== member.tools[at]?.name)
    );
  });
}

/**
 * Resolve the Applet members of the Bot's next Composition generation.
 *
 * Called before a Turn is admitted, never inside the admission transaction: it
 * reads the User Durable Object, and an admitted Turn's pin is taken in one
 * storage transaction that cannot make a cross-object call. The result is a
 * proposal the next admission pins — a published generation activates at the
 * next admitted Turn, which is why an in-flight Turn keeps the set it
 * pinned.
 */
export async function resolveAppletCompositionV1(options: {
  directory: Pick<AppletUserDirectoryV1, "compositionInput">;
  composition: Pick<CompositionStore, "current" | "propose">;
  storage: AppletCapabilityStorageV1;
  origin: CompositionGenerationV1["origin"];
  now?: Date;
}): Promise<CompositionGenerationV1 | undefined> {
  // Reading the User object yields, so the pointer can move under this
  // proposal exactly as it can under deployment-follow: the pin is a
  // compare-and-swap, and a lost race re-reads the directory and the winner's
  // members rather than replacing them.
  return pinCompositionWithRetryV1(() => appletCompositionAttempt(options));
}

async function appletCompositionAttempt(options: {
  directory: Pick<AppletUserDirectoryV1, "compositionInput">;
  composition: Pick<CompositionStore, "current" | "propose">;
  storage: AppletCapabilityStorageV1;
  origin: CompositionGenerationV1["origin"];
  now?: Date;
}): Promise<CompositionGenerationV1 | undefined> {
  const current = await options.composition.current();
  const seen = await options.storage.get<number>(
    APPLET_DIRECTORY_REVISION_SEEN_KEY,
  );
  const input = await options.directory.compositionInput();
  const members = appletCompositionMembersV1(input.applets);
  if (
    seen === input.revision &&
    !appletMembersDifferV1(members, current.applets ?? [])
  ) {
    return undefined;
  }
  if (!appletMembersDifferV1(members, current.applets ?? [])) {
    await options.storage.put({
      [APPLET_DIRECTORY_REVISION_SEEN_KEY]: input.revision,
    });
    return undefined;
  }
  const createdAt = (options.now ?? new Date()).toISOString();
  const artifactSetHash = await compositionArtifactSetHashV1(
    current.members,
    members,
  );
  const generation = decodeCompositionGenerationV1({
    schemaVersion: 1,
    generationId: compositionGenerationIdV1(createdAt, artifactSetHash),
    artifactSetHash,
    parentGenerationId: current.generationId,
    createdAt,
    origin: options.origin,
    members: current.members,
    ...(members.length === 0 ? {} : { applets: members }),
    status: "pending",
  });
  await options.composition.propose(generation, {
    pin: true,
    expectedCurrentGenerationId: current.generationId,
  });
  await options.storage.put({
    [APPLET_DIRECTORY_REVISION_SEEN_KEY]: input.revision,
  });
  return generation;
}

function publishEffectKey(effectId: string): string {
  return `${APPLET_PUBLISH_EFFECT_PREFIX}${effectId}`;
}

function failed(
  appletId: string,
  generationId: string,
  reason: string,
  diagnostics: string[] = [],
): AppletPublishResultV1 {
  return {
    status: "failed",
    appletId,
    generationId,
    reason: reason.slice(0, 512),
    diagnostics,
  };
}

/**
 * The relative paths one Applet's source occupies, listed out of the store.
 *
 * The list prefix is the Applet id without its trailing slash: the store
 * validates a prefix as a relative path, and a path may not end in one. The
 * entries are then narrowed to the directory itself, so a listing can never
 * pick up a neighbour whose id merely starts the same way.
 */
async function listAppletSourceV1(
  workspace: WorkspaceFilesV1,
  userId: string,
  appletId: string,
): Promise<
  { entries: { path: string; size: number }[] } | { failure: string }
> {
  const prefix = appletSourcePathV1(appletId);
  const listed = await workspace.list({
    root: appletsSourceRootV1(userId),
    prefix: prefix.slice(0, -1),
    limit: APPLET_BUILD_LIMITS.files + 1,
  });
  if (listed.status !== "ok") {
    return {
      failure: `the Applet's source could not be listed: ${listed.status}${
        listed.reason ? ` — ${listed.reason}` : ""
      }`,
    };
  }
  const entries = listed.entries
    .filter((entry) => entry.path.path.startsWith(prefix))
    .map((entry) => ({
      path: entry.path.path.slice(prefix.length),
      size: entry.generation.size,
    }))
    .filter((entry) => entry.path.length > 0)
    .sort((left, right) => left.path.localeCompare(right.path));
  return { entries };
}

/** `ctx.applets` over the Bot Durable Object's authority. */
export function createAppletCapabilityHostV1(
  options: AppletCapabilityHostOptionsV1,
): AppletCapabilityHostV1 {
  const now = options.now ?? (() => new Date());

  /**
   * One Applet's whole source, as the build service is posted it.
   *
   * The store is the home of Applet source, so this is a listing and a read
   * per file — no Computer, no `dist/`, and nothing to reconcile first. The
   * bounds are the contract's, refused here rather than after the bytes have
   * crossed the wire.
   */
  async function readSource(
    appletId: string,
  ): Promise<{ files: AppletBuildSourceFileV1[] } | { failure: string }> {
    const listed = await listAppletSourceV1(
      options.workspace,
      options.userId,
      appletId,
    );
    if ("failure" in listed) return listed;
    const paths = listed.entries.map((entry) => entry.path);
    if (paths.length === 0) {
      return {
        failure: `${appletId} has no source. Call applet_create, or write server.ts, ui.tsx and applet.json with applet_write_file.`,
      };
    }
    if (paths.length > APPLET_BUILD_LIMITS.files) {
      return {
        failure: `${appletId} has more than ${APPLET_BUILD_LIMITS.files} source files; the build service takes no more.`,
      };
    }
    const files: AppletBuildSourceFileV1[] = [];
    let total = 0;
    for (const path of paths) {
      const outcome = await options.workspace.read(
        appletSourceFilePathV1(options.userId, appletId, path),
      );
      if (outcome.status !== "ok") {
        return { failure: `"${path}" is ${outcome.status}` };
      }
      const text = TEXT.decode(outcome.file.bytes);
      total += text.length;
      if (
        text.length > APPLET_BUILD_LIMITS.fileText ||
        total > APPLET_BUILD_LIMITS.sourceBytes
      ) {
        return {
          failure: `${appletId}'s source is over the ${APPLET_BUILD_LIMITS.sourceBytes}-byte ceiling the build service accepts.`,
        };
      }
      files.push({ path, text });
    }
    return { files };
  }

  /**
   * Read the source, build it, and verify what came back.
   *
   * The service is handed bytes and returns bytes; the hashes it declares are
   * checked against the artifacts here, in the authority that stores them, so a
   * builder that lied about what it compiled is refused before anything points
   * at it.
   */
  async function build(
    appletId: string,
    effectId: string,
  ): Promise<
    | { built: { manifest: AppletBuildManifestV1; server: string; ui: string } }
    | { failure: string; diagnostics?: string[] }
  > {
    const service = options.buildService;
    if (!service) {
      return {
        failure:
          "the Applet build service is unavailable in this deployment, so nothing can be built or published",
      };
    }
    const source = await readSource(appletId);
    if ("failure" in source) return { failure: source.failure };
    const request: AppletBuildRequestV1 = {
      version: APPLET_BUILD_PROTOCOL_VERSION,
      effectId,
      appletId,
      mode: "build",
      files: source.files,
    };
    let response: AppletBuildResponseV1;
    try {
      response = await service.build(request);
    } catch (error) {
      return {
        failure: `the Applet build service could not be reached: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    if (response.status === "failed") {
      return {
        failure: `the build failed at the ${response.stage} stage`,
        diagnostics: response.diagnostics.map(appletDiagnosticTextV1),
      };
    }
    if (
      !response.manifest ||
      response.server === undefined ||
      response.ui === undefined
    ) {
      return { failure: "the build returned no artifacts" };
    }
    const serverHash = await sha256Hex(response.server);
    const uiHash = await sha256Hex(response.ui);
    if (
      response.manifest.hashes.server !== serverHash ||
      response.manifest.hashes.ui !== uiHash
    ) {
      return {
        failure:
          "the build service returned artifacts its manifest does not describe",
        diagnostics: [
          `server declared:${response.manifest.hashes.server} actual:${serverHash}`,
          `ui declared:${response.manifest.hashes.ui} actual:${uiHash}`,
        ],
      };
    }
    return {
      built: {
        manifest: response.manifest,
        server: response.server,
        ui: response.ui,
      },
    };
  }

  /**
   * The artifacts, content-addressed. Immutable and written before anything
   * points at them, and idempotent by their own key: the same source stores
   * the same two objects however many times it is built.
   */
  async function storeArtifacts(built: {
    manifest: AppletBuildManifestV1;
    server: string;
    ui: string;
  }): Promise<void> {
    await options.artifacts.putPackageArtifact(
      built.manifest.hashes.server,
      built.server,
    );
    await options.artifacts.putPackageUiArtifact(
      built.manifest.hashes.ui,
      built.ui,
    );
  }

  /** The manifest's tools, as the directory and a generation record them. */
  function declaredTools(
    manifest: AppletBuildManifestV1,
  ): AppletToolDeclarationV1[] {
    return manifest.tools.map((tool, index) =>
      decodeAppletToolDeclarationV1(tool, `Applet tool declaration[${index}]`),
    );
  }

  /**
   * A tool name another Applet already owns, refused here rather than at the
   * mount. Every Applet's tools share one Bot tool catalog, and the registry
   * refuses a duplicate at mount — which would fail the whole Composition
   * closed for a name clash. At publish the Bot can rename it and try again.
   */
  async function toolNameClashes(
    appletId: string,
    tools: readonly AppletToolDeclarationV1[],
  ): Promise<string[]> {
    const others = (await options.directory.list()).applets.filter(
      (applet) => applet.appletId !== appletId && applet.status !== "deleted",
    );
    const taken = new Map<string, string>();
    for (const other of others) {
      for (const name of other.tools) taken.set(name, other.displayName);
    }
    return tools
      .filter((tool) => taken.has(tool.name))
      .map(
        (tool) =>
          `"${tool.name}" is already a tool of "${taken.get(tool.name)}"`,
      );
  }

  /** The page a built UI artifact is served at, when an origin is configured. */
  function previewUrl(uiHash: string): { previewUrl?: string } {
    if (!options.appOrigin) return {};
    try {
      return {
        previewUrl: appletPreviewUrlV1(new URL(options.appOrigin), uiHash),
      };
    } catch {
      return {};
    }
  }

  async function setFocus(appletId: string | null): Promise<FocusedAppletV1> {
    const focused = decodeFocusedAppletV1({
      schemaVersion: 1,
      appletId,
      changedAt: now().toISOString(),
    });
    await options.storage.put({ [APPLET_FOCUSED_KEY]: focused });
    return focused;
  }

  async function proposeAfterDirectoryChange(
    scope: AppletCapabilityCallScopeV1,
  ): Promise<string | undefined> {
    const generation = await resolveAppletCompositionV1({
      directory: options.directory,
      composition: options.composition,
      storage: options.storage,
      origin: {
        kind: "bot-authored",
        runId: scope.runId,
        sessionId: scope.sessionId,
        turnId: scope.turnId,
      },
      now: now(),
    });
    return generation?.generationId;
  }

  async function activate(
    input: {
      appletId: string;
      generation: AppletGenerationV1;
      tools: AppletToolDeclarationV1[];
    },
    scope: AppletCapabilityCallScopeV1,
    origin: "publish" | "revert",
  ): Promise<AppletPublishResultV1> {
    const instance = options.instanceFor(input.appletId);
    const mounted =
      origin === "publish"
        ? await instance.publish({
            appletId: input.appletId,
            generation: input.generation,
          })
        : await instance.revert({
            appletId: input.appletId,
            generation: input.generation,
          });
    if (mounted.status === "failed") {
      return failed(
        input.appletId,
        mounted.generationId,
        mounted.reason,
        mounted.diagnostics,
      );
    }
    // The directory follows the mount, never precedes it: the tools a Bot is
    // offered are the tools the resident generation actually reported.
    await options.directory.recordGeneration({
      appletId: input.appletId,
      generationId: mounted.generationId,
      tools: input.tools,
    });
    const compositionGenerationId = await proposeAfterDirectoryChange(scope);
    return {
      status: "published",
      appletId: input.appletId,
      generationId: mounted.generationId,
      tools: mounted.tools,
      ...(compositionGenerationId ? { compositionGenerationId } : {}),
    };
  }

  return {
    async list() {
      return (await options.directory.list()).applets.map((applet) =>
        decodeAppletSummaryV1(applet),
      );
    },

    async create(input, scope) {
      const created = await options.directory.create({
        displayName: input.displayName,
        provenance: {
          kind: "bot",
          botId: options.botId,
          sessionId: scope.sessionId,
          turnId: scope.turnId,
        },
      });
      // "`applet_create` and `applet_publish` set focus by default" (plan §6).
      await setFocus(created.appletId);
      return created;
    },

    async files(input) {
      const listed = await listAppletSourceV1(
        options.workspace,
        options.userId,
        input.appletId,
      );
      if ("failure" in listed) throw new Error(listed.failure);
      return listed.entries satisfies AppletSourceFileV1[];
    },

    async readFile(input) {
      const outcome = await options.workspace.read(
        appletSourceFilePathV1(options.userId, input.appletId, input.path),
      );
      if (outcome.status !== "ok") {
        throw new Error(`"${input.path}" is ${outcome.status}`);
      }
      return TEXT.decode(outcome.file.bytes);
    },

    async writeFile(input, scope) {
      const path = appletSourceFilePathV1(
        options.userId,
        input.appletId,
        input.path,
      );
      // The generation the write supersedes, read immediately before it. A
      // `null` assertion means "this file does not exist", so an overwrite
      // that passed it would lose to the file it means to replace.
      const existing = await options.workspace.stat(path);
      const outcome = await options.workspace.write({
        path,
        bytes: new TextEncoder().encode(input.text),
        writer: {
          kind: "bot",
          botId: options.botId,
          sessionId: scope.sessionId,
          turnId: scope.turnId,
          runId: scope.runId,
        },
        expectedGenerationId:
          existing.status === "ok"
            ? existing.entry.generation.generationId
            : null,
        mediaType: sourceMediaType(input.path),
      });
      if (outcome.status !== "ok") {
        throw new Error(
          `"${input.path}" could not be written: ${outcome.status}${
            outcome.reason ? ` — ${outcome.reason}` : ""
          }`,
        );
      }
    },

    async check(input, scope) {
      const outcome = await build(input.appletId, scope.effectId);
      if ("failure" in outcome) {
        return {
          status: "failed",
          reason: outcome.failure,
          diagnostics: outcome.diagnostics ?? [],
        };
      }
      // The artifacts are stored even though nothing is published: that is
      // what makes the preview URL resolve, and a content-addressed put of
      // bytes the app already hash-verified points at nothing until a
      // generation names it.
      await storeArtifacts(outcome.built);
      return {
        status: "checked",
        tools: outcome.built.manifest.tools.map((tool) => tool.name),
        ...previewUrl(outcome.built.manifest.hashes.ui),
      };
    },

    async publish(input, scope) {
      const key = publishEffectKey(scope.effectId);
      const recorded = await options.storage.get<AppletPublishIntentV1>(key);
      if (recorded?.outcome) return recorded.outcome;
      // Intent first, before a byte is read or written. A recovery reads this
      // back and settles the effect rather than repeating it.
      const intent: AppletPublishIntentV1 = recorded ?? {
        schemaVersion: 1,
        effectId: scope.effectId,
        appletId: input.appletId,
        botId: options.botId,
        sessionId: scope.sessionId,
        turnId: scope.turnId,
        runId: scope.runId,
        recordedAt: now().toISOString(),
      };
      if (!recorded) await options.storage.put({ [key]: intent });

      const settle = async (
        outcome: AppletPublishResultV1,
      ): Promise<AppletPublishResultV1> => {
        await options.storage.put({ [key]: { ...intent, outcome } });
        return outcome;
      };

      const outcome = await build(input.appletId, scope.effectId);
      if ("failure" in outcome) {
        return settle(
          failed(
            input.appletId,
            "unbuilt",
            outcome.failure,
            outcome.diagnostics ?? [],
          ),
        );
      }
      const tools = declaredTools(outcome.built.manifest);
      const clashes = await toolNameClashes(input.appletId, tools);
      if (clashes.length > 0) {
        return settle(
          failed(
            input.appletId,
            "unbuilt",
            "an Applet tool name is already taken by another Applet; rename it and publish again",
            clashes,
          ),
        );
      }
      await storeArtifacts(outcome.built);
      const serverHash = outcome.built.manifest.hashes.server;
      const uiHash = outcome.built.manifest.hashes.ui;

      const createdAt = now().toISOString();
      const existing = await options
        .instanceFor(input.appletId)
        .read({ appletId: input.appletId });
      const generation = decodeAppletGenerationV1({
        schemaVersion: 1,
        generationId: appletGenerationIdV1(createdAt, serverHash),
        ...(existing.current
          ? { parentGenerationId: existing.current.generationId }
          : {}),
        server: {
          contentHash: serverHash,
          size: outcome.built.server.length,
          mediaType: "application/javascript",
          bundlerVersion: `applet-build-contract-${APPLET_CONTRACT_V1}`,
        },
        ui: {
          contentHash: uiHash,
          size: outcome.built.ui.length,
          mediaType: "text/html",
          bundlerVersion: `applet-build-contract-${APPLET_CONTRACT_V1}`,
        },
        tools,
        contract: 1,
        origin: "publish",
        provenance: {
          botId: options.botId,
          sessionId: scope.sessionId,
          turnId: scope.turnId,
          runId: scope.runId,
        },
        createdAt,
        status: "pending",
      });
      const published = await activate(
        { appletId: input.appletId, generation, tools },
        scope,
        "publish",
      );
      if (published.status === "published") await setFocus(input.appletId);
      return settle(published);
    },

    async revert(input, scope) {
      const instance = options.instanceFor(input.appletId);
      const state = await instance.read({ appletId: input.appletId });
      const target = state.generations.find(
        (generation) => generation.generationId === input.generationId,
      );
      if (!target) {
        return failed(
          input.appletId,
          input.generationId,
          `Applet "${input.appletId}" has no generation "${input.generationId}"`,
        );
      }
      const createdAt = now().toISOString();
      // A revert is itself a recorded generation, never a mutation of the one
      // it points back to (plan D5).
      const generation = decodeAppletGenerationV1({
        ...target,
        generationId: appletGenerationIdV1(
          createdAt,
          target.server.contentHash,
        ),
        ...(state.current
          ? { parentGenerationId: state.current.generationId }
          : {}),
        origin: "revert",
        provenance: {
          botId: options.botId,
          sessionId: scope.sessionId,
          turnId: scope.turnId,
          runId: scope.runId,
        },
        createdAt,
        status: "pending",
      });
      return activate(
        { appletId: input.appletId, generation, tools: target.tools },
        scope,
        "revert",
      );
    },

    async delete(input) {
      await options.directory.delete(input.appletId);
      const focused = await options.storage.get<unknown>(APPLET_FOCUSED_KEY);
      if (
        focused !== undefined &&
        decodeFocusedAppletV1(focused).appletId === input.appletId
      ) {
        await setFocus(null);
      }
      return { status: "deleted" };
    },

    focus(input) {
      return setFocus(input.appletId);
    },

    async generations(input) {
      const state = await options
        .instanceFor(input.appletId)
        .read({ appletId: input.appletId });
      return state.generations
        .sort((left, right) =>
          right.generationId.localeCompare(left.generationId),
        )
        .map((generation) => ({
          generationId: generation.generationId,
          ...(generation.parentGenerationId
            ? { parentGenerationId: generation.parentGenerationId }
            : {}),
          origin: generation.origin,
          status: generation.status,
          tools: generation.tools.map((tool) => tool.name),
          createdAt: generation.createdAt,
          isCurrent: state.current?.generationId === generation.generationId,
        }));
    },

    async readFocused() {
      const stored = await options.storage.get<unknown>(APPLET_FOCUSED_KEY);
      return stored === undefined
        ? {
            schemaVersion: 1,
            appletId: null,
            changedAt: new Date(0).toISOString(),
          }
        : decodeFocusedAppletV1(stored);
    },
  };
}
