import { type Context, FiberState, type Plugin, Service } from "cordis";
import {
  type ContributionKind,
  decodeFrockBotManifest,
  declaredContributionKinds,
  type FrockBotManifest,
} from "./manifest.ts";

export * from "./manifest.ts";

// Runtime source imports stay explicit because Electron executes workspace TypeScript.
export type PackageStatus =
  "installed" | "activating" | "active" | "disabling" | "failed";

export interface PackageSource {
  specifier: string;
  manifest: unknown;
}

export interface PackageDescriptor {
  specifier: string;
  manifest: FrockBotManifest;
}

export interface ActiveContribution {
  dispose(): Promise<void>;
}

export interface PreparedContribution {
  kind: ContributionKind;
  commit(): Promise<ActiveContribution>;
  rollback(): Promise<void>;
}

export interface ContributionHost {
  kind: ContributionKind;
  prepare(pkg: PackageDescriptor): Promise<PreparedContribution | undefined>;
}

export interface PackageSummary extends PackageDescriptor {
  status: PackageStatus;
  error?: string;
}

interface PackageRecord extends PackageSummary {
  active: ActiveContribution[];
}

declare module "cordis" {
  interface Context {
    packages: PackageCatalog;
  }

  interface Events {
    "package/status": (pkg: PackageSummary) => void;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function summary(record: PackageRecord): PackageSummary {
  const { active: _active, ...value } = record;
  return value;
}

export interface PackageCatalogConfig {
  kinds?: ContributionKind[];
}

export class PackageCatalog extends Service {
  private hosts = new Map<ContributionKind, ContributionHost>();
  private records = new Map<string, PackageRecord>();
  private kinds: Set<ContributionKind> | undefined;

  constructor(ctx: Context, config: PackageCatalogConfig = {}) {
    super(ctx, "packages");
    this.kinds = config.kinds ? new Set(config.kinds) : undefined;
  }

  registerHost(host: ContributionHost): () => void {
    if (this.hosts.has(host.kind)) {
      throw new Error(`contribution host "${host.kind}" is already registered`);
    }
    this.hosts.set(host.kind, host);
    return () => {
      if (this.hosts.get(host.kind) === host) this.hosts.delete(host.kind);
    };
  }

  install(source: PackageSource): PackageSummary {
    const manifest = decodeFrockBotManifest(source.manifest);
    if (this.records.has(manifest.id)) {
      throw new Error(`package "${manifest.id}" is already installed`);
    }
    const record: PackageRecord = {
      specifier: source.specifier,
      manifest,
      status: "installed",
      active: [],
    };
    this.records.set(manifest.id, record);
    this.publish(record);
    return summary(record);
  }

  get(packageId: string): PackageSummary | undefined {
    const record = this.records.get(packageId);
    return record ? summary(record) : undefined;
  }

  list(): PackageSummary[] {
    return [...this.records.values()].map(summary);
  }

  async enable(packageId: string): Promise<void> {
    const record = this.requireRecord(packageId);
    if (record.status === "active") return;
    if (record.status === "activating" || record.status === "disabling") {
      throw new Error(`package "${packageId}" is busy`);
    }
    record.status = "activating";
    record.error = undefined;
    this.publish(record);

    const descriptor = summary(record);
    const prepared: PreparedContribution[] = [];
    const active: ActiveContribution[] = [];
    try {
      for (const kind of declaredContributionKinds(record.manifest)) {
        if (this.kinds && !this.kinds.has(kind)) continue;
        const host = this.hosts.get(kind);
        if (!host)
          throw new Error(`no contribution host is registered for "${kind}"`);
        const contribution = await host.prepare(descriptor);
        if (!contribution) {
          throw new Error(`host "${kind}" refused package "${packageId}"`);
        }
        prepared.push(contribution);
      }
      for (const contribution of prepared) {
        active.push(await contribution.commit());
      }
      record.active = active;
      record.status = "active";
      this.publish(record);
    } catch (error) {
      const failures: unknown[] = [error];
      for (const contribution of active.toReversed()) {
        try {
          await contribution.dispose();
        } catch (disposeError) {
          failures.push(disposeError);
        }
      }
      for (const contribution of prepared.slice(active.length).toReversed()) {
        try {
          await contribution.rollback();
        } catch (rollbackError) {
          failures.push(rollbackError);
        }
      }
      record.active = [];
      record.status = "failed";
      record.error = errorMessage(error);
      this.publish(record);
      if (failures.length === 1) throw error;
      throw new AggregateError(
        failures,
        `package "${packageId}" activation rollback failed`,
      );
    }
  }

  async disable(packageId: string): Promise<void> {
    const record = this.requireRecord(packageId);
    if (record.status === "installed") return;
    if (record.status !== "active" && record.status !== "failed") {
      throw new Error(`package "${packageId}" is busy`);
    }
    record.status = "disabling";
    this.publish(record);
    const failures: unknown[] = [];
    for (const contribution of record.active.toReversed()) {
      try {
        await contribution.dispose();
      } catch (error) {
        failures.push(error);
      }
    }
    record.active = [];
    record.status = failures.length > 0 ? "failed" : "installed";
    record.error = failures.length > 0 ? errorMessage(failures[0]) : undefined;
    this.publish(record);
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `package "${packageId}" did not disable cleanly`,
      );
    }
  }

  uninstall(packageId: string): void {
    const record = this.requireRecord(packageId);
    if (record.status !== "installed") {
      throw new Error(
        `package "${packageId}" must be disabled before uninstall`,
      );
    }
    this.records.delete(packageId);
  }

  [Service.init](): () => Promise<void> {
    return async () => {
      const active = [...this.records.values()].filter(
        (record) => record.active.length > 0,
      );
      await Promise.all(
        active.map((record) => this.disable(record.manifest.id)),
      );
      this.records.clear();
      this.hosts.clear();
    };
  }

  private requireRecord(packageId: string): PackageRecord {
    const record = this.records.get(packageId);
    if (!record) throw new Error(`package "${packageId}" is not installed`);
    return record;
  }

  private publish(record: PackageRecord): void {
    this.ctx.emit("package/status", summary(record));
  }
}

export type ContributionResolver = (specifier: string) => Promise<unknown>;

export class PassiveContributionHost implements ContributionHost {
  readonly kind: ContributionKind;

  constructor(kind: ContributionKind) {
    this.kind = kind;
  }

  prepare(pkg: PackageDescriptor): Promise<PreparedContribution | undefined> {
    const contribution = pkg.manifest.contributions[this.kind];
    if (!contribution) return Promise.resolve(undefined);
    return Promise.resolve({
      kind: this.kind,
      commit: () => Promise.resolve({ dispose: () => Promise.resolve() }),
      rollback: () => Promise.resolve(),
    });
  }
}

function unwrapPlugin(module: unknown): Plugin | undefined {
  if (typeof module === "function") return module as Plugin;
  if (!module || typeof module !== "object") return undefined;
  const candidate = (module as { default?: unknown }).default;
  if (typeof candidate === "function") return candidate as Plugin;
  if (candidate && typeof candidate === "object" && "apply" in candidate) {
    return candidate as Plugin;
  }
  return undefined;
}

export class LocalCordisContributionHost implements ContributionHost {
  readonly kind: "runtime" | "desktop" | "mobile";
  private readonly ctx: Context;
  private readonly resolve: ContributionResolver;

  constructor(
    kind: "runtime" | "desktop" | "mobile",
    ctx: Context,
    resolve: ContributionResolver,
  ) {
    this.kind = kind;
    this.ctx = ctx;
    this.resolve = resolve;
  }

  async prepare(
    pkg: PackageDescriptor,
  ): Promise<PreparedContribution | undefined> {
    const contribution = pkg.manifest.contributions[this.kind];
    if (!contribution) return undefined;
    const module = await this.resolve(
      `${pkg.specifier}${contribution.entry.slice(1)}`,
    );
    const plugin = unwrapPlugin(module);
    if (!plugin || !this.ctx.registry.resolve(plugin)) {
      throw new Error(
        `package "${pkg.manifest.id}" has an invalid ${this.kind} plugin`,
      );
    }
    let fiber: ReturnType<Context["plugin"]> | undefined;
    return {
      kind: this.kind,
      commit: async () => {
        try {
          fiber = this.ctx.plugin(plugin);
          await fiber;
          if (fiber.state !== FiberState.ACTIVE) {
            throw new Error(`${this.kind} contribution did not become active`);
          }
        } catch (error) {
          await fiber?.dispose();
          throw error;
        }
        return { dispose: () => fiber?.dispose() ?? Promise.resolve() };
      },
      rollback: async () => {
        await fiber?.dispose();
      },
    };
  }
}
