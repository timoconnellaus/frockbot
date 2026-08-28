import { type Context, Service } from "cordis";

/** Persistent identity used to resolve one Bot's selected Computer. */
export interface ComputerTarget {
  userId: string;
  botId: string;
}

export interface ComputerAssignment {
  providerId: string;
  generation: number;
  configuration?: unknown;
}

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

export function normalizeComputerPath(path: string): string {
  const normalized = path.trim();
  const segments = normalized.split("/");
  if (
    !normalized ||
    normalized !== path ||
    normalized.startsWith("/") ||
    normalized.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(normalized) ||
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

export interface ComputerWorkspace {
  openDirectory(
    request: {
      namespace: string;
      scope: "bot" | "user";
      durability: "durable";
    },
    options?: ComputerOperationOptions,
  ): Promise<ComputerDirectory>;
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

export interface ComputerHandle {
  assignment: ComputerAssignment;
  workspace?: ComputerWorkspace;
  exec?: ComputerExec;
  browser?: ComputerBrowser;
  viewer?: ComputerViewer;
  control?: ComputerControl;
  close(): Promise<void>;
}

export interface ComputerProvider {
  id: string;
  open(
    target: ComputerTarget,
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

function guardedDirectory(
  directory: ComputerDirectory,
  assertCurrent: () => void,
): ComputerDirectory {
  return {
    readFile: (path, options) =>
      guardedOperation(assertCurrent, () => directory.readFile(path, options)),
    writeFile: (path, bytes, options) =>
      guardedOperation(assertCurrent, () =>
        directory.writeFile(path, bytes, options),
      ),
    deleteFile: (path, options) =>
      guardedOperation(assertCurrent, () =>
        directory.deleteFile(path, options),
      ),
    listFiles: (options) =>
      guardedOperation(assertCurrent, () => directory.listFiles(options)),
  };
}

function guardedHandle(
  handle: ComputerHandle,
  assertCurrent: () => void,
): ComputerHandle {
  const { workspace, exec, browser, viewer, control } = handle;
  return {
    assignment: handle.assignment,
    workspace: workspace
      ? {
          openDirectory: (request, options) =>
            guardedOperation(assertCurrent, () =>
              workspace
                .openDirectory(request, options)
                .then((directory) => guardedDirectory(directory, assertCurrent)),
            ),
        }
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

function targetKey(target: ComputerTarget): string {
  const userId = target.userId.trim();
  const botId = target.botId.trim();
  if (!userId || !botId) {
    throw new ComputerError(
      "invalid-request",
      "Computer target requires non-empty userId and botId",
    );
  }
  return `${encodeURIComponent(userId)}:${encodeURIComponent(botId)}`;
}

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
    target: ComputerTarget,
    providerId: string,
    configuration?: unknown,
  ): ComputerAssignment {
    const key = targetKey(target);
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

  assignment(target: ComputerTarget): ComputerAssignment | undefined {
    return this.assignments.get(targetKey(target));
  }

  async open(
    target: ComputerTarget,
    options?: ComputerOperationOptions,
  ): Promise<ComputerHandle> {
    options?.signal?.throwIfAborted();
    const assignment = this.assignments.get(targetKey(target));
    if (!assignment) {
      throw new ComputerError(
        "not-assigned",
        `Bot "${target.botId}" has no Computer assignment`,
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
    const handle = await provider.open(target, assignment, options);
    return guardedHandle(handle, () => {
      const current = this.assignments.get(targetKey(target));
      if (
        current?.providerId !== assignment.providerId ||
        current.generation !== assignment.generation
      ) {
        throw new ComputerError(
          "stale-assignment",
          `Computer assignment for Bot "${target.botId}" changed`,
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

// Keep provider selection process-local; cross-process callers use DTOs.
export {};
