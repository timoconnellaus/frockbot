import {
  decodeFrockBotManifest,
  isClientIframeContribution,
  type FrockBotManifest,
} from "./manifest.ts";
import { decodeArtifactRefV1, type ArtifactRefV1 } from "./generation.ts";
import { satisfies, valid } from "semver";

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface ApplicationPackageSelection {
  specifier: string;
  version: string;
  config?: JsonValue;
  grants: string[];
  /**
   * The immutable module bytes this member loads from.
   *
   * Absent ⇒ first-party, in-process: the application resolves the member's
   * Contributions from its own Contribution table, which is how every member
   * of the foundation application works today. Present ⇒ the member loads
   * through the isolate host like a Bot-authored Package, even though its
   * provenance is first-party — the shape ADR 0022 gives the Applets Package.
   * Declaring one changes nothing about how the plan is compiled; it only
   * records that the code is not in this bundle.
   */
  artifact?: ArtifactRefV1;
}

export interface ApplicationSource {
  schemaVersion: 1;
  packages: ApplicationPackageSelection[];
}

export interface ResolvedPackageSource {
  specifier: string;
  manifest: unknown;
}

export type ApplicationPackageResolver = (
  specifier: string,
  version: string,
) => Promise<ResolvedPackageSource>;

export type ApplicationPackageDeclarationResolver = (
  specifier: string,
  version: string,
) => ResolvedPackageSource;

export interface CompiledPackage {
  id: string;
  specifier: string;
  version: string;
  config: JsonValue;
  grants: string[];
  manifest: FrockBotManifest;
  /** Absent ⇒ first-party in-process; present ⇒ loaded from the artifact. */
  artifact?: ArtifactRefV1;
}

export interface ApplicationPlan {
  schemaVersion: 1;
  applicationHash: string;
  packages: CompiledPackage[];
  contributions: {
    backend: string[];
    runtime: string[];
    client: string[];
    desktop: string[];
    mobile: string[];
  };
}

export type ApplicationDeclarationPlan = Omit<
  ApplicationPlan,
  "applicationHash"
>;

export interface CompileApplicationOptions {
  frockbotVersion: string;
}

export function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("application data must be finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") {
    throw new Error("application data must be JSON serializable");
  }
  return `{${Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function assertVersion(version: string, label: string): void {
  if (!valid(version))
    throw new Error(`${label} must be a valid semver version`);
}

function validateGrants(pkg: CompiledPackage): void {
  const grants = new Set(pkg.grants);
  if (grants.size !== pkg.grants.length) {
    throw new Error(`package "${pkg.id}" contains duplicate grants`);
  }
  for (const permission of pkg.manifest.permissions) {
    if (!grants.has(permission)) {
      throw new Error(`package "${pkg.id}" is missing grant "${permission}"`);
    }
  }
  for (const grant of grants) {
    if (!pkg.manifest.permissions.includes(grant)) {
      throw new Error(
        `package "${pkg.id}" received undeclared grant "${grant}"`,
      );
    }
  }
}

function orderedPackages(
  packages: Map<string, CompiledPackage>,
): CompiledPackage[] {
  const order: CompiledPackage[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id))
      throw new Error(`package dependency cycle includes "${id}"`);
    const pkg = packages.get(id);
    if (!pkg) throw new Error(`package "${id}" is missing`);
    visiting.add(id);
    for (const [dependencyId, range] of Object.entries(
      pkg.manifest.dependencies,
    ).sort(([left], [right]) => left.localeCompare(right))) {
      const dependency = packages.get(dependencyId);
      if (!dependency) {
        // A disabled-by-default Package may depend on a Package available only
        // from the User's Catalog. Settings refuses to enable it until an
        // installed dependency row exists; enabled built-ins still fail here.
        if (pkg.manifest.defaultEnablement === "disabled") continue;
        throw new Error(
          `package "${pkg.id}" requires missing package "${dependencyId}"`,
        );
      }
      if (!satisfies(dependency.version, range)) {
        throw new Error(
          `package "${pkg.id}" requires ${dependencyId}@${range}, received ${dependency.version}`,
        );
      }
      visit(dependencyId);
    }
    visiting.delete(id);
    visited.add(id);
    order.push(pkg);
  };

  for (const id of [...packages.keys()].sort()) visit(id);
  return order;
}

function validateClientComposition(packages: readonly CompiledPackage[]): void {
  const clients = packages.flatMap((pkg) => {
    const client = pkg.manifest.contributions.client;
    return client && !isClientIframeContribution(client)
      ? [{ id: pkg.id, client }]
      : [];
  });
  const roots = clients.flatMap(({ id, client }) =>
    client.mounts.filter((mount) => mount.slot === "root").map(() => id),
  );
  if (roots.length > 1) {
    throw new Error(`multiple client roots declared by: ${roots.join(", ")}`);
  }
  const outlets = new Set(clients.flatMap(({ client }) => client.outlets));
  for (const { id, client } of clients) {
    for (const mount of client.mounts) {
      if (mount.slot !== "root" && !outlets.has(mount.slot)) {
        throw new Error(
          `package "${id}" mounts undeclared client slot "${mount.slot}"`,
        );
      }
    }
  }
}

export function compileApplicationDeclarations(
  source: ApplicationSource,
  resolvePackage: ApplicationPackageDeclarationResolver,
  options: CompileApplicationOptions,
): ApplicationDeclarationPlan {
  if (source.schemaVersion !== 1) {
    throw new Error("unsupported application source version");
  }
  assertVersion(options.frockbotVersion, "FrockBot version");
  const byId = new Map<string, CompiledPackage>();
  const specifiers = new Set<string>();

  for (const selection of source.packages) {
    if (specifiers.has(selection.specifier)) {
      throw new Error(`duplicate package specifier "${selection.specifier}"`);
    }
    specifiers.add(selection.specifier);
    assertVersion(
      selection.version,
      `package "${selection.specifier}" version`,
    );
    const resolved = resolvePackage(selection.specifier, selection.version);
    if (resolved.specifier !== selection.specifier) {
      throw new Error(
        `resolver returned the wrong package for "${selection.specifier}"`,
      );
    }
    const manifest = decodeFrockBotManifest(resolved.manifest);
    if (manifest.version !== selection.version) {
      throw new Error(
        `package "${manifest.id}" manifest version does not match selection`,
      );
    }
    if (!satisfies(options.frockbotVersion, manifest.compatibility.frockbot)) {
      throw new Error(
        `package "${manifest.id}" is incompatible with FrockBot ${options.frockbotVersion}`,
      );
    }
    if (byId.has(manifest.id)) {
      throw new Error(`duplicate package id "${manifest.id}"`);
    }
    const artifact =
      selection.artifact === undefined
        ? undefined
        : decodeArtifactRefV1(
            selection.artifact,
            `package "${selection.specifier}" artifact`,
          );
    const pkg: CompiledPackage = {
      id: manifest.id,
      specifier: selection.specifier,
      version: selection.version,
      config: selection.config ?? null,
      grants: [...selection.grants].sort(),
      manifest,
      ...(artifact === undefined ? {} : { artifact }),
    };
    validateGrants(pkg);
    byId.set(pkg.id, pkg);
  }

  const packages = orderedPackages(byId);
  validateClientComposition(packages);
  return {
    schemaVersion: 1 as const,
    packages,
    contributions: {
      backend: packages
        .filter((pkg) => pkg.manifest.contributions.backend)
        .map((pkg) => pkg.id),
      runtime: packages
        .filter((pkg) => pkg.manifest.contributions.runtime)
        .map((pkg) => pkg.id),
      client: packages
        .filter((pkg) => pkg.manifest.contributions.client)
        .map((pkg) => pkg.id),
      desktop: packages
        .filter((pkg) => pkg.manifest.contributions.desktop)
        .map((pkg) => pkg.id),
      mobile: packages
        .filter((pkg) => pkg.manifest.contributions.mobile)
        .map((pkg) => pkg.id),
    },
  };
}

export async function compileApplicationPlan(
  source: ApplicationSource,
  resolvePackage: ApplicationPackageResolver,
  options: CompileApplicationOptions,
): Promise<ApplicationPlan> {
  const resolved = new Map<string, ResolvedPackageSource>();
  for (const selection of source.packages) {
    resolved.set(
      `${selection.specifier}\0${selection.version}`,
      await resolvePackage(selection.specifier, selection.version),
    );
  }
  const unsigned = compileApplicationDeclarations(
    source,
    (specifier, version) => {
      const pkg = resolved.get(`${specifier}\0${version}`);
      if (!pkg) throw new Error(`unknown package: ${specifier}`);
      return pkg;
    },
    options,
  );
  return {
    ...unsigned,
    applicationHash: await sha256(canonicalJson(unsigned)),
  };
}
