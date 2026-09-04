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
// constitution's rule requires: record intent, then read, then verify, then the
// immutable artifact, then the durable records, then the mount, then the
// Composition proposal. A crash anywhere resumes from the recorded intent
// rather than repeating a side effect.
import {
  appletGenerationIdV1,
  APPLETS_PACKAGE_ID_V1,
  APPLETS_SOURCE_ROOT_ID_V1,
  APPLET_CONTRACT_V1,
  APPLET_FOCUSED_KEY,
  decodeFocusedAppletV1,
  type FocusedAppletV1,
} from "@frockbot/kernel-do";
import {
  decodeAppletGenerationV1,
  decodeAppletSummaryV1,
  decodeAppletToolDeclarationV1,
  type AppletGenerationSummaryV1,
  type AppletGenerationV1,
  type AppletProvenanceV1,
  type AppletPublishResultV1,
  type AppletSummaryV1,
  type AppletToolDeclarationV1,
} from "@frockbot/kernel-contracts";
import type {
  WorkspacePathV1,
  WorkspaceReadsV1,
} from "@frockbot/kernel-contracts";
import {
  compositionArtifactSetHashV1,
  compositionGenerationIdV1,
  decodeCompositionGenerationV1,
  type CompositionAppletMemberV1,
  type CompositionJsonValueV1,
  type CompositionGenerationV1,
  type CompositionStore,
  type PackageProvenanceV1,
} from "@frockbot/kernel-composition/generation";

/** The durable key one publish intent is recorded under, by effect id. */
export const APPLET_PUBLISH_EFFECT_PREFIX = "applets:publish-effect:";
/**
 * The directory revision the Bot's current Composition generation resolved
 * Applet members at. A revision that no longer matches the User's is the whole
 * of the fan-out signal.
 */
export const APPLET_DIRECTORY_REVISION_SEEN_KEY = "applets:directory-revision";

/** The three files `applet build` writes, read from the durable root. */
export const APPLET_DIST_FILES_V1 = [
  "dist/server.js",
  "dist/ui.html",
  "dist/manifest.json",
] as const;

/**
 * Ceilings on what a publish will read and store.
 *
 * The UI bound is the Applet one, not the Package-page one: a Package page is
 * hand-written inline HTML and 256 KB is generous, while an Applet's page is
 * `applet build`'s single self-contained file carrying React, TanStack DB, and
 * the kit — roughly half a megabyte before the Applet's own code.
 */
export const APPLET_MAX_SERVER_BYTES_V1 = 2 * 1024 * 1024;
export const APPLET_MAX_UI_BYTES_V1 = 4 * 1024 * 1024;
export const APPLET_MAX_MANIFEST_BYTES_V1 = 64 * 1024;

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
  invokeTool(input: {
    appletId: string;
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
              envelope({ tool: input.tool, toolInput: input.input ?? null }),
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
  /** Reads the built Applet under the Applets Package's declared root. */
  workspace: WorkspaceReadsV1;
  /**
   * Forces a pull of the `applets/source` root before it is read, so a publish
   * sees what the Bot just wrote on the Computer rather than the last synced
   * copy.
   *
   * The Bot Durable Object supplies it over the Computer Package's
   * `syncWorkspaceRootNowV1` when the User has a Computer. Absent means the
   * store is read as it stands — correct but possibly stale — and the Bot is
   * told so in the failure when the files are missing, rather than the publish
   * silently using old bytes.
   */
  syncSourceRootNow?(appletId: string): Promise<void>;
  composition: Pick<CompositionStore, "current" | "lastKnownGood" | "propose">;
  now?(): Date;
}

export interface AppletCapabilityCallScopeV1 {
  sessionId: string;
  runId: string;
  turnId: string;
  effectId: string;
}

/** `ctx.applets`, as the Bot Durable Object implements it. */
export interface AppletCapabilityHostV1 {
  list(): Promise<AppletSummaryV1[]>;
  create(
    input: { displayName: string },
    scope: AppletCapabilityCallScopeV1,
  ): Promise<AppletSummaryV1>;
  publish(
    input: { appletId: string },
    scope: AppletCapabilityCallScopeV1,
  ): Promise<AppletPublishResultV1>;
  revert(
    input: { appletId: string; generationId: string },
    scope: AppletCapabilityCallScopeV1,
  ): Promise<AppletPublishResultV1>;
  delete(input: { appletId: string }): Promise<{ status: "deleted" }>;
  focus(input: { appletId: string | null }): Promise<FocusedAppletV1>;
  generations(input: {
    appletId: string;
  }): Promise<AppletGenerationSummaryV1[]>;
  /** What the shell reads for the canvas, and what a route projects. */
  readFocused(): Promise<FocusedAppletV1>;
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

/** The declared-root path one of an Applet's built files lives at. */
export function appletDistPathV1(
  userId: string,
  appletId: string,
  file: string,
): WorkspacePathV1 {
  return {
    root: {
      kind: "package-declared",
      userId,
      packageId: APPLETS_PACKAGE_ID_V1,
      rootId: APPLETS_SOURCE_ROOT_ID_V1,
    },
    path: `${appletId}/${file}`,
  };
}

/**
 * `dist/manifest.json` as `applet build` writes it. Verified against the bytes
 * actually read, so a manifest cannot name code it does not describe.
 */
export interface AppletBuildManifestV1 {
  contract: 1;
  tools: AppletToolDeclarationV1[];
  hashes: { server: string; ui: string };
}

export function decodeAppletBuildManifestV1(
  input: unknown,
  label = "Applet build manifest",
): AppletBuildManifestV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${label} must be an object`);
  }
  const value = input as Record<string, unknown>;
  const keys = ["contract", "tools", "hashes"] as const;
  const allowed = new Set<string>(keys);
  if (
    !Object.keys(value).every((key) => allowed.has(key)) ||
    !keys.every((key) => Object.hasOwn(value, key))
  ) {
    throw new Error(`${label} has invalid fields`);
  }
  if (value.contract !== 1) throw new Error(`${label}.contract is unsupported`);
  if (!Array.isArray(value.tools) || value.tools.length > 64) {
    throw new Error(`${label}.tools must be a bounded array`);
  }
  const tools = value.tools.map((tool, index) =>
    decodeAppletToolDeclarationV1(tool, `${label}.tools[${index}]`),
  );
  if (new Set(tools.map((tool) => tool.name)).size !== tools.length) {
    throw new Error(`${label}.tools contains duplicate names`);
  }
  const hashes = value.hashes;
  if (!hashes || typeof hashes !== "object" || Array.isArray(hashes)) {
    throw new Error(`${label}.hashes must be an object`);
  }
  const { server, ui } = hashes as Record<string, unknown>;
  if (typeof server !== "string" || !/^[0-9a-f]{64}$/.test(server)) {
    throw new Error(`${label}.hashes.server must be a sha-256 hex digest`);
  }
  if (typeof ui !== "string" || !/^[0-9a-f]{64}$/.test(ui)) {
    throw new Error(`${label}.hashes.ui must be a sha-256 hex digest`);
  }
  return { contract: 1, tools, hashes: { server, ui } };
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
 * proposal the next admission pins — which is exactly ADR 0022's "a published
 * generation activates at the next admitted Turn", and why an in-flight Turn
 * keeps the set it pinned.
 */
export async function resolveAppletCompositionV1(options: {
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
  await options.composition.propose(generation, { pin: true });
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

/** `ctx.applets` over the Bot Durable Object's authority. */
export function createAppletCapabilityHostV1(
  options: AppletCapabilityHostOptionsV1,
): AppletCapabilityHostV1 {
  const now = options.now ?? (() => new Date());

  async function readFile(
    appletId: string,
    file: string,
    maximum: number,
  ): Promise<{ text: string } | { failure: string }> {
    const outcome = await options.workspace.read(
      appletDistPathV1(options.userId, appletId, file),
    );
    if (outcome.status !== "ok") {
      return {
        failure: `"${file}" is ${outcome.status}: run \`applet build\` in applets/${appletId} on the Computer first`,
      };
    }
    if (outcome.file.bytes.byteLength > maximum) {
      return { failure: `"${file}" exceeds its ${maximum}-byte bound` };
    }
    return { text: TEXT.decode(outcome.file.bytes) };
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

      // Force a pull of the source root so the publish sees what the Bot just
      // built, not the last synced copy. See the seam note on the option.
      await options.syncSourceRootNow?.(input.appletId);

      const server = await readFile(
        input.appletId,
        "dist/server.js",
        APPLET_MAX_SERVER_BYTES_V1,
      );
      if ("failure" in server) {
        return settle(failed(input.appletId, "unbuilt", server.failure));
      }
      const ui = await readFile(
        input.appletId,
        "dist/ui.html",
        APPLET_MAX_UI_BYTES_V1,
      );
      if ("failure" in ui) {
        return settle(failed(input.appletId, "unbuilt", ui.failure));
      }
      const manifestFile = await readFile(
        input.appletId,
        "dist/manifest.json",
        APPLET_MAX_MANIFEST_BYTES_V1,
      );
      if ("failure" in manifestFile) {
        return settle(failed(input.appletId, "unbuilt", manifestFile.failure));
      }
      let manifest: AppletBuildManifestV1;
      try {
        manifest = decodeAppletBuildManifestV1(JSON.parse(manifestFile.text));
      } catch (error) {
        return settle(
          failed(
            input.appletId,
            "unbuilt",
            `dist/manifest.json is invalid: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
      }
      // Every Applet's tools share one Bot tool catalog, and the registry
      // refuses a duplicate name at mount — which would fail the whole
      // Composition closed for a name clash. So the clash is refused here, at
      // publish, where the Bot can rename the tool and try again.
      const others = (await options.directory.list()).applets.filter(
        (applet) =>
          applet.appletId !== input.appletId && applet.status !== "deleted",
      );
      const taken = new Map<string, string>();
      for (const other of others) {
        for (const name of other.tools) taken.set(name, other.displayName);
      }
      const clashes = manifest.tools
        .filter((tool) => taken.has(tool.name))
        .map(
          (tool) =>
            `"${tool.name}" is already a tool of "${taken.get(tool.name)}"`,
        );
      if (clashes.length > 0) {
        return settle(
          failed(
            input.appletId,
            "unbuilt",
            "an Applet tool name is already taken by another Applet; rename it and run `applet build` again",
            clashes,
          ),
        );
      }

      const serverHash = await sha256Hex(server.text);
      const uiHash = await sha256Hex(ui.text);
      if (
        manifest.hashes.server !== serverHash ||
        manifest.hashes.ui !== uiHash
      ) {
        return settle(
          failed(
            input.appletId,
            "unbuilt",
            "dist/manifest.json does not match the built files; run `applet build` again",
            [
              `server declared:${manifest.hashes.server} actual:${serverHash}`,
              `ui declared:${manifest.hashes.ui} actual:${uiHash}`,
            ],
          ),
        );
      }

      // Immutable, content-addressed, and written before anything points at it.
      await options.artifacts.putPackageArtifact(serverHash, server.text);
      await options.artifacts.putPackageUiArtifact(uiHash, ui.text);

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
          size: server.text.length,
          mediaType: "application/javascript",
          bundlerVersion: `applet-cli-contract-${APPLET_CONTRACT_V1}`,
        },
        ui: {
          contentHash: uiHash,
          size: ui.text.length,
          mediaType: "text/html",
          bundlerVersion: `applet-cli-contract-${APPLET_CONTRACT_V1}`,
        },
        tools: manifest.tools,
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
      const outcome = await activate(
        { appletId: input.appletId, generation, tools: manifest.tools },
        scope,
        "publish",
      );
      if (outcome.status === "published") await setFocus(input.appletId);
      return settle(outcome);
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
