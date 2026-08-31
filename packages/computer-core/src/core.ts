import {
  workspaceRootKeyV1,
  type WorkspaceFileV1,
  type WorkspaceFilesV1,
  type WorkspaceListRequestV1,
  type WorkspacePathV1,
  type WorkspaceRootKindV1,
  type WorkspaceRootV1,
  type WorkspaceWriterV1,
} from "@frockbot/kernel-contracts";
import { type Context, Service } from "cordis";

export type ComputerErrorCode =
  | "not-assigned"
  | "provider-unavailable"
  | "capability-unavailable"
  | "stale-assignment"
  | "human-control-active"
  | "invalid-request"
  | "conflict"
  | "limit-exceeded"
  | "aborted"
  | "provider-failure";

export class ComputerError extends Error {
  constructor(
    readonly code: ComputerErrorCode,
    message: string,
    readonly retryable = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ComputerError";
  }
}

/**
 * The provisioning key of a Computer. "One Computer serves all of a User's
 * Bots" (ADR 0012), so a Computer is identified by its User and by nothing
 * else. Provisioning, hibernation, the browser profile, and the Workspace are
 * all properties of this identity.
 */
export interface ComputerIdentityV1 {
  userId: string;
}

/**
 * One Bot as a tenant of its User's Computer. "each Bot receives its own
 * directories and desktop on it, and all Bots share the User's browser
 * profile." Separation between tenants is organizational, not a security
 * boundary — `directory` and `display` are conventions the Computer provider
 * Package enforces, never isolation the caller may rely on.
 *
 * A caller supplies `botId`; a provider answers on its handle with the
 * `directory` and `display` it resolved for that tenant.
 */
export interface ComputerTenantV1 {
  botId: string;
  /** The tenant's directory tree, relative to the Workspace root. */
  directory?: string;
  /** The tenant's desktop, when the provider offers one. */
  display?: string;
}

/**
 * The assignment key. One Computer per User means one key per User: two Bots
 * of one User resolve to one assignment and one generation.
 */
export function computerIdentityKeyV1(identity: ComputerIdentityV1): string {
  const userId = identity.userId.trim();
  if (!userId) {
    throw new ComputerError(
      "invalid-request",
      "Computer identity requires a non-empty userId",
    );
  }
  return encodeURIComponent(userId);
}

/** Validates the tenant making a call and returns its normalized Bot id. */
export function computerTenantBotIdV1(tenant: ComputerTenantV1): string {
  const botId = tenant.botId.trim();
  if (!botId) {
    throw new ComputerError(
      "invalid-request",
      "Computer tenant requires a non-empty botId",
    );
  }
  return botId;
}

/**
 * One durable root a Computer Package's Workspace layout declares: "durable
 * roots, declared by the Computer Package's Workspace layout and by Package
 * manifests, survive hibernation, cold start, host migration, and image
 * rebuild; everything else on the Computer may be lost."
 *
 * `kind` is the kernel's `WorkspaceRootKindV1`, so the Computer Package, the
 * Skills loader, and the Memory Package all name the same roots. `access` is
 * how the Computer presents the root: Memory roots are `read-only` there
 * because the Memory Package is their single writer (ADR 0013).
 *
 * `mountPath` is a template. Three placeholders are substituted:
 * `{bot}` — the provider's directory key for the tenant Bot;
 * `{package}` — a `package-declared` root's Package id, made path-safe;
 * `{root}` — a `package-declared` root's `rootId`.
 */
export interface WorkspaceRootDeclarationV1 {
  kind: WorkspaceRootKindV1;
  /** Present only when the declaration covers one `package-declared` rootId. */
  rootId?: string;
  scope: "user" | "bot";
  /** Absolute path template on the Computer where the root is mounted. */
  mountPath: string;
  access: "read-write" | "read-only";
}

/** The durable roots one Computer Package declares for a User's Computer. */
export interface WorkspaceLayoutV1 {
  schemaVersion: 1;
  /** The Workspace root on the Computer, e.g. `/home/box`. */
  home: string;
  roots: WorkspaceRootDeclarationV1[];
}

/** The declaration governing one root, or `undefined` when none does. */
export function workspaceRootDeclarationV1(
  layout: WorkspaceLayoutV1,
  root: WorkspaceRootV1,
): WorkspaceRootDeclarationV1 | undefined {
  return layout.roots.find(
    (declaration) =>
      declaration.kind === root.kind &&
      (declaration.rootId === undefined ||
        (root.kind === "package-declared" &&
          declaration.rootId === root.rootId)),
  );
}

function pathSafe(value: string): string {
  return (
    value
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "unnamed"
  );
}

/**
 * Resolves one durable root to its absolute mount path on the Computer.
 *
 * `botDirectoryKey` maps a Bot id to the provider's own directory key. It is
 * applied to the *root's* owner, never to the caller: Bots of one User share
 * one Computer and may read each other's Workspace files, so the mount of
 * another Bot's root is that Bot's directory, not the reader's.
 *
 * No caller outside a Computer Package ever sees a mount path.
 */
export function workspaceMountPathV1(
  layout: WorkspaceLayoutV1,
  root: WorkspaceRootV1,
  botDirectoryKey?: (botId: string) => string,
): string {
  const declaration = workspaceRootDeclarationV1(layout, root);
  if (!declaration) {
    throw new ComputerError(
      "capability-unavailable",
      `This Computer declares no durable root for ${workspaceRootKeyV1(root)}`,
    );
  }
  const resolved = declaration.mountPath
    .replace("{bot}", () => {
      if (!botDirectoryKey || !("botId" in root)) {
        throw new ComputerError(
          "invalid-request",
          `A Bot-scoped durable root needs a Bot: ${workspaceRootKeyV1(root)}`,
        );
      }
      return botDirectoryKey(root.botId);
    })
    .replace("{package}", () =>
      root.kind === "package-declared" ? pathSafe(root.packageId) : "",
    )
    .replace("{root}", () =>
      root.kind === "package-declared" ? root.rootId : "",
    );
  if (
    !resolved.startsWith("/") ||
    resolved.includes("//") ||
    resolved.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new ComputerError(
      "provider-failure",
      `Computer mount path is not a normalized absolute path: ${resolved}`,
    );
  }
  return resolved;
}

export interface ComputerAssignment {
  providerId: string;
  generation: number;
  configuration?: unknown;
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export function normalizeComputerPath(path: string): string {
  const normalized = path.trim();
  const segments = normalized.split("/");
  if (
    !normalized ||
    normalized !== path ||
    normalized.startsWith("/") ||
    normalized.includes("\\") ||
    CONTROL_CHARACTERS.test(normalized) ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new ComputerError(
      "invalid-request",
      `Invalid relative Computer path: ${JSON.stringify(path)}`,
    );
  }
  return normalized;
}

export interface ComputerOperationOptions {
  signal?: AbortSignal;
}

export interface ComputerFileInfo {
  path: string;
  version: string;
  size: number;
  modifiedAt?: string;
  mediaType?: string;
}

export interface ComputerFile extends ComputerFileInfo {
  bytes: Uint8Array;
}

export interface ComputerFilePage {
  files: ComputerFileInfo[];
  cursor?: string;
}

export interface ComputerDirectory {
  readFile(
    path: string,
    options?: ComputerOperationOptions,
  ): Promise<ComputerFile | null>;
  writeFile(
    path: string,
    bytes: Uint8Array,
    options?: ComputerOperationOptions & {
      ifVersion?: string | null;
      mediaType?: string;
    },
  ): Promise<ComputerFileInfo>;
  deleteFile(
    path: string,
    options?: ComputerOperationOptions & { ifVersion?: string },
  ): Promise<boolean>;
  listFiles(
    options?: ComputerOperationOptions & {
      prefix?: string;
      cursor?: string;
      limit?: number;
    },
  ): Promise<ComputerFilePage>;
}

/**
 * The Computer's Workspace surface.
 *
 * It *is* `WorkspaceFilesV1` — the narrow file interface the kernel declares —
 * addressed by `WorkspacePathV1`, so a durable root is named by kind and owner
 * and never by an absolute path on the Computer. `layout` is where mount paths
 * live, and the only place they live.
 *
 * Memory roots are read-only here: `write` and `delete` answer `refused`,
 * because "The Memory Package is the single writer of Memory roots ... the
 * Workspace presents Memory roots read-only through the durable-root sync."
 */
export interface ComputerWorkspace extends WorkspaceFilesV1 {
  readonly layout: WorkspaceLayoutV1;
  /**
   * RETIRED — ADR 0013 / `docs/plans/slice-2.md` Step 3b.
   *
   * @deprecated The Computer-side Memory write path is gone. Memory roots come
   * from object storage through the durable-root sync and are presented
   * read-only on the Computer, so this seam answers `refused` to every call. It
   * remains only so the Memory Package's replacement can land in a separate
   * change; delete the property once nothing names it.
   */
  readonly memoryWriter: WorkspaceFilesV1;
}

/**
 * A `WorkspaceFilesV1` that refuses everything, as a declared outcome rather
 * than a throw. It is how a retired seam stays type-compatible while writing
 * nothing: the Computer host is non-authoritative, so "this surface does not
 * serve you" is an ordinary answer its callers already handle.
 */
export function refusedWorkspaceFilesV1(reason: string): WorkspaceFilesV1 {
  const refused = () => Promise.resolve({ status: "refused" as const, reason });
  return {
    read: refused,
    list: refused,
    stat: refused,
    write: refused,
    delete: refused,
  };
}

type WorkspaceOutcomeFailure = { status: string; reason: string };

/**
 * Adapts one durable root of a `WorkspaceFilesV1` surface to the older
 * path-relative `ComputerDirectory` shape, recording `writer` on every write.
 *
 * `ComputerDirectory` has no unconditional write, so an unconditional
 * `writeFile` reads the current generation first and retries once on a losing
 * conditional write; a second conflict surfaces rather than being merged.
 */
export function computerDirectoryForRootV1(
  files: WorkspaceFilesV1,
  root: WorkspaceRootV1,
  writer: WorkspaceWriterV1,
): ComputerDirectory {
  const at = (path: string): WorkspacePathV1 => ({
    root,
    path: normalizeComputerPath(path),
  });
  const fail = (failure: WorkspaceOutcomeFailure, path: string): never => {
    const code: ComputerErrorCode =
      failure.status === "conflict"
        ? "conflict"
        : failure.status === "refused"
          ? "capability-unavailable"
          : failure.status === "unavailable"
            ? "provider-unavailable"
            : "invalid-request";
    throw new ComputerError(code, `${failure.reason} (${path})`);
  };
  const currentGenerationId = async (
    path: string,
  ): Promise<string | null | undefined> => {
    const current = await files.stat(at(path));
    if (current.status === "ok") return current.entry.generation.generationId;
    if (current.status === "not-found") return null;
    return fail(current, path);
  };
  const write = async (
    path: string,
    bytes: Uint8Array,
    options: ComputerOperationOptions & {
      ifVersion?: string | null;
      mediaType?: string;
    },
  ): Promise<ComputerFileInfo> => {
    const media = options.mediaType ? { mediaType: options.mediaType } : {};
    const attempt = async (expected: string | null) =>
      files.write({
        path: at(path),
        bytes,
        writer,
        expectedGenerationId: expected,
        ...media,
      });
    let outcome = await attempt(
      options.ifVersion !== undefined
        ? options.ifVersion
        : ((await currentGenerationId(path)) ?? null),
    );
    if (outcome.status === "conflict" && options.ifVersion === undefined) {
      outcome = await attempt((await currentGenerationId(path)) ?? null);
    }
    if (outcome.status !== "ok") return fail(outcome, path);
    return {
      path: normalizeComputerPath(path),
      version: outcome.generation.generationId,
      size: outcome.generation.size,
      modifiedAt: outcome.generation.writtenAt,
      ...media,
    };
  };
  return {
    async readFile(path, options = {}) {
      options.signal?.throwIfAborted();
      const outcome = await files.read(at(path));
      if (outcome.status === "not-found") return null;
      if (outcome.status !== "ok") return fail(outcome, path);
      const file: WorkspaceFileV1 = outcome.file;
      return {
        path: file.path.path,
        version: file.generation.generationId,
        size: file.generation.size,
        modifiedAt: file.generation.writtenAt,
        bytes: file.bytes,
      };
    },
    writeFile(path, bytes, options = {}) {
      options.signal?.throwIfAborted();
      return write(path, bytes, options);
    },
    async deleteFile(path, options = {}) {
      options.signal?.throwIfAborted();
      const expected =
        options.ifVersion ?? (await currentGenerationId(path)) ?? null;
      if (expected === null) return false;
      const outcome = await files.delete({
        path: at(path),
        writer,
        expectedGenerationId: expected,
      });
      if (outcome.status === "not-found") return false;
      if (outcome.status !== "ok") return fail(outcome, path);
      return true;
    },
    async listFiles(options = {}) {
      options.signal?.throwIfAborted();
      const request: WorkspaceListRequestV1 = {
        root,
        ...(options.prefix
          ? { prefix: normalizeComputerPath(options.prefix) }
          : {}),
        ...(options.cursor ? { cursor: options.cursor } : {}),
        ...(options.limit ? { limit: options.limit } : {}),
      };
      const outcome = await files.list(request);
      if (outcome.status !== "ok") return fail(outcome, options.prefix ?? "");
      return {
        files: outcome.entries.map((entry) => ({
          path: entry.path.path,
          version: entry.generation.generationId,
          size: entry.generation.size,
          modifiedAt: entry.generation.writtenAt,
        })),
        ...(outcome.cursor ? { cursor: outcome.cursor } : {}),
      };
    },
  };
}

export interface ComputerExecRequest {
  executable: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: Uint8Array;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface ComputerExecResult {
  exitCode: number | null;
  signal?: string;
  stdout: Uint8Array;
  stderr: Uint8Array;
  outputTruncated: boolean;
}

export interface ComputerExec {
  execute(
    request: ComputerExecRequest,
    options?: ComputerOperationOptions,
  ): Promise<ComputerExecResult>;
}

export type ComputerBrowserAction =
  | { type: "snapshot" }
  | { type: "navigate"; url: string }
  | { type: "click"; role: string; name: string; exact?: boolean }
  | { type: "fill"; label: string; text: string; exact?: boolean }
  | { type: "press"; key: string }
  | { type: "wait"; milliseconds: number };

export interface ComputerBrowserState {
  url?: string;
  title?: string;
  accessibilitySnapshot: string;
}

export interface ComputerBrowser {
  perform(
    action: ComputerBrowserAction,
    options?: ComputerOperationOptions,
  ): Promise<ComputerBrowserState>;
}

export interface ComputerViewerSession {
  id: string;
  url: string;
  expiresAt?: string;
}

export interface ComputerViewer {
  open(options?: ComputerOperationOptions): Promise<ComputerViewerSession>;
  revoke(sessionId: string, options?: ComputerOperationOptions): Promise<void>;
}

export interface ComputerControlLease {
  id: string;
  expiresAt: string;
}

export interface ComputerControl {
  acquire(options?: ComputerOperationOptions): Promise<ComputerControlLease>;
  renew(
    lease: ComputerControlLease,
    options?: ComputerOperationOptions,
  ): Promise<ComputerControlLease>;
  release(
    lease: ComputerControlLease,
    options?: ComputerOperationOptions,
  ): Promise<void>;
}

/**
 * One open Computer, addressed by the User whose Computer it is and by the Bot
 * tenant that opened it. The provider answers with the tenant's resolved
 * directory and desktop.
 */
export interface ComputerHandle {
  assignment: ComputerAssignment;
  identity: ComputerIdentityV1;
  tenant: ComputerTenantV1;
  workspace?: ComputerWorkspace;
  exec?: ComputerExec;
  browser?: ComputerBrowser;
  viewer?: ComputerViewer;
  control?: ComputerControl;
  close(): Promise<void>;
}

export interface ComputerProvider {
  id: string;
  /**
   * The durable roots this provider guarantees. Absent when a provider
   * declares no durable root.
   */
  workspaceLayout?: WorkspaceLayoutV1;
  /**
   * Provisions the User's Computer when needed and attaches one Bot tenant to
   * it. The split arguments are ADR 0012 in a signature: `identity` is the
   * provisioning key, `tenant` is the caller, and a provider can finally tell
   * "provision the Computer" from "attach this tenant".
   */
  open(
    identity: ComputerIdentityV1,
    tenant: ComputerTenantV1,
    assignment: ComputerAssignment,
    options?: ComputerOperationOptions,
  ): Promise<ComputerHandle>;
}

function guardedOperation<T>(
  assertCurrent: () => void,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    assertCurrent();
    return operation();
  } catch (error) {
    return Promise.reject(error);
  }
}

function guardedFiles(
  files: WorkspaceFilesV1,
  assertCurrent: () => void,
): WorkspaceFilesV1 {
  return {
    read: (path) => guardedOperation(assertCurrent, () => files.read(path)),
    list: (request) =>
      guardedOperation(assertCurrent, () => files.list(request)),
    stat: (path) => guardedOperation(assertCurrent, () => files.stat(path)),
    write: (request) =>
      guardedOperation(assertCurrent, () => files.write(request)),
    delete: (request) =>
      guardedOperation(assertCurrent, () => files.delete(request)),
  };
}

function guardedWorkspace(
  workspace: ComputerWorkspace,
  assertCurrent: () => void,
): ComputerWorkspace {
  return {
    ...guardedFiles(workspace, assertCurrent),
    layout: workspace.layout,
    memoryWriter: guardedFiles(workspace.memoryWriter, assertCurrent),
  };
}

function guardedHandle(
  handle: ComputerHandle,
  assertCurrent: () => void,
): ComputerHandle {
  const { workspace, exec, browser, viewer, control } = handle;
  return {
    assignment: handle.assignment,
    identity: handle.identity,
    tenant: handle.tenant,
    workspace: workspace
      ? guardedWorkspace(workspace, assertCurrent)
      : undefined,
    exec: exec
      ? {
          execute: (request, options) =>
            guardedOperation(assertCurrent, () =>
              exec.execute(request, options),
            ),
        }
      : undefined,
    browser: browser
      ? {
          perform: (action, options) =>
            guardedOperation(assertCurrent, () =>
              browser.perform(action, options),
            ),
        }
      : undefined,
    viewer: viewer
      ? {
          open: (options) =>
            guardedOperation(assertCurrent, () => viewer.open(options)),
          revoke: (sessionId, options) =>
            guardedOperation(assertCurrent, () =>
              viewer.revoke(sessionId, options),
            ),
        }
      : undefined,
    control: control
      ? {
          acquire: (options) =>
            guardedOperation(assertCurrent, () => control.acquire(options)),
          renew: (lease, options) =>
            guardedOperation(assertCurrent, () =>
              control.renew(lease, options),
            ),
          release: (lease, options) =>
            guardedOperation(assertCurrent, () =>
              control.release(lease, options),
            ),
        }
      : undefined,
    close: () => handle.close(),
  };
}

/**
 * The Computer assignments of the resident application, keyed per User.
 *
 * "The User's Durable Object is the authority for everything User-scoped:
 * ... the Computer assignment" — so the assignment map is keyed by
 * `ComputerIdentityV1` alone. Two Bots of one User share one assignment, one
 * generation, and one provider Computer; each is a tenant on it.
 */
export class ComputerRegistry extends Service {
  private readonly providers = new Map<string, ComputerProvider>();
  private readonly assignments = new Map<string, ComputerAssignment>();

  constructor(ctx: Context) {
    super(ctx, "computers");
  }

  register(provider: ComputerProvider): () => void {
    const id = provider.id.trim();
    if (!id) throw new Error("Computer provider id must be non-empty");
    if (this.providers.has(id)) {
      throw new Error(`Computer provider "${id}" is already registered`);
    }
    this.providers.set(id, provider);
    return () => {
      if (this.providers.get(id) === provider) this.providers.delete(id);
    };
  }

  assign(
    identity: ComputerIdentityV1,
    providerId: string,
    configuration?: unknown,
  ): ComputerAssignment {
    const key = computerIdentityKeyV1(identity);
    const normalizedProviderId = providerId.trim();
    if (!this.providers.has(normalizedProviderId)) {
      throw new ComputerError(
        "provider-unavailable",
        `Computer provider "${normalizedProviderId}" is unavailable`,
      );
    }
    const previous = this.assignments.get(key);
    const assignment = {
      providerId: normalizedProviderId,
      generation: (previous?.generation ?? 0) + 1,
      configuration,
    } satisfies ComputerAssignment;
    this.assignments.set(key, assignment);
    return assignment;
  }

  assignment(identity: ComputerIdentityV1): ComputerAssignment | undefined {
    return this.assignments.get(computerIdentityKeyV1(identity));
  }

  async open(
    identity: ComputerIdentityV1,
    tenant: ComputerTenantV1,
    options?: ComputerOperationOptions,
  ): Promise<ComputerHandle> {
    options?.signal?.throwIfAborted();
    const key = computerIdentityKeyV1(identity);
    computerTenantBotIdV1(tenant);
    const assignment = this.assignments.get(key);
    if (!assignment) {
      throw new ComputerError(
        "not-assigned",
        `User "${identity.userId}" has no Computer assignment`,
      );
    }
    const provider = this.providers.get(assignment.providerId);
    if (!provider) {
      throw new ComputerError(
        "provider-unavailable",
        `Computer provider "${assignment.providerId}" is unavailable`,
        true,
      );
    }
    const handle = await provider.open(identity, tenant, assignment, options);
    return guardedHandle(handle, () => {
      const current = this.assignments.get(key);
      if (
        current?.providerId !== assignment.providerId ||
        current.generation !== assignment.generation
      ) {
        throw new ComputerError(
          "stale-assignment",
          `Computer assignment for User "${identity.userId}" changed`,
        );
      }
    });
  }
}

declare module "cordis" {
  interface Context {
    computers: ComputerRegistry;
  }
}
