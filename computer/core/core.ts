import {
  workspaceRootKeyV1,
  type WorkspaceRootKindV1,
  type WorkspaceRootV1,
} from "@frockbot/core/contracts";
import { createHash } from "node:crypto";

/**
 * A stable, provider-neutral directory name for one Bot inside a User-scoped
 * durable root.
 *
 * A Package that files something per Bot under a root the whole User shares
 * needs a name that is the same on every Computer and on every provider, so it
 * is derived here rather than borrowed from whichever provider happens to be
 * mounted. It is a path segment, never an identity: the writer of a file is
 * what the generation records.
 */
export function computerBotPathKeyV1(botId: string): string {
  const id = botId.trim();
  if (!id) throw new Error("Computer Bot id must be non-empty");
  const slug = id
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28);
  const digest = createHash("sha256").update(id).digest("hex").slice(0, 12);
  return `${slug || "bot"}-${digest}`;
}

export type ComputerErrorCode =
  | "not-assigned"
  | "provider-unavailable"
  | "capability-unavailable"
  | "stale-assignment"
  | "human-control-active"
  | "updating"
  | "invalid-request"
  | "conflict"
  | "limit-exceeded"
  | "aborted"
  | "provider-failure";

/**
 * What every seam says when this deployment has no Computer at all.
 *
 * One sentence, in the words the person reading it would use. It names no
 * environment variable and no settings screen — a Computer is wired in when the
 * app is deployed, and nothing a User or a Bot can do inside the product
 * changes it, so inventing a remedy here only sends the User looking for a
 * control that does not exist. It also names no part of the architecture: what
 * the reader has lost is the ability to have the Bot browse and run tasks, and
 * that is what the sentence says.
 */
export const COMPUTER_UNCONFIGURED_MESSAGE_V1 =
  "This Bot has no computer, so it can't browse the web or run tasks for you.";

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
 * The provisioning key of a Computer. One Computer serves all of a User's
 * Bots, so a Computer is identified by its User and by nothing else.
 * Provisioning, hibernation, the browser profile, and the Workspace are all
 * properties of this identity.
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
 * because the Memory Package is their single writer.
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
  effectId?: string;
}

/** Provider-neutral detail for provisioning nested under a connection step. */
