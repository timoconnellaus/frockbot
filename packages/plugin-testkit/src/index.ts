import {
  type ContributionKind,
  decodeFrockBotManifest,
  declaredContributionKinds,
  isClientIframeContribution,
  type FrockBotManifest,
} from "@frockbot/kernel-composition";
import { Context, type Plugin } from "cordis";

export interface PluginPackageFixture {
  packageJson: unknown;
  manifest: unknown;
}

export interface VerifiedPluginPackage {
  name: string;
  manifest: FrockBotManifest;
  contributionKinds: ContributionKind[];
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireExport(
  exports: Record<string, unknown>,
  key: string,
  issues: string[],
): void {
  if (!(key in exports)) issues.push(`package exports must include "${key}"`);
}

export function verifyPluginPackage(
  fixture: PluginPackageFixture,
): VerifiedPluginPackage {
  const manifest = decodeFrockBotManifest(fixture.manifest);
  const packageJson = record(fixture.packageJson, "package.json");
  const name = nonEmptyString(packageJson.name, "package.json name");
  const version = nonEmptyString(packageJson.version, "package.json version");
  const exports = record(packageJson.exports, "package.json exports");
  const frockbot = record(packageJson.frockbot, "package.json frockbot field");
  const issues: string[] = [];

  const expectedName = `@frockbot/plugin-${manifest.id}`;
  if (name !== expectedName) {
    issues.push(`package name must be "${expectedName}"`);
  }
  if (version !== manifest.version) {
    issues.push("package and manifest versions must match");
  }
  if (packageJson.private !== true) {
    issues.push("plugin workspace packages must be private");
  }
  if (frockbot.manifest !== "./frockbot.json") {
    issues.push('package.json frockbot.manifest must be "./frockbot.json"');
  }

  requireExport(exports, ".", issues);
  requireExport(exports, "./manifest", issues);
  requireExport(exports, "./frockbot.json", issues);
  requireExport(exports, "./package.json", issues);
  for (const contribution of [
    manifest.contributions.runtime,
    manifest.contributions.desktop,
    manifest.contributions.mobile,
  ]) {
    if (contribution) requireExport(exports, contribution.entry, issues);
  }
  const client = manifest.contributions.client;
  if (client && !isClientIframeContribution(client)) {
    requireExport(exports, client.entry, issues);
  }
  if (new Set(manifest.permissions).size !== manifest.permissions.length) {
    issues.push("manifest permissions must not contain duplicates");
  }

  if (issues.length > 0) {
    throw new AggregateError(
      issues.map((issue) => new Error(issue)),
      `plugin package "${manifest.id}" is invalid:\n- ${issues.join("\n- ")}`,
    );
  }

  return {
    name,
    manifest,
    contributionKinds: declaredContributionKinds(manifest),
  };
}

export class PluginHarness {
  readonly root: Context;
  private disposed = false;

  constructor(root: Context = new Context()) {
    this.root = root;
  }

  async mount(plugin: Plugin) {
    if (this.disposed) throw new Error("plugin harness is disposed");
    return await this.root.plugin(plugin);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.root.fiber.dispose();
  }
}

export async function createPluginHarness(
  setup: readonly Plugin[] = [],
): Promise<PluginHarness> {
  const harness = new PluginHarness();
  try {
    for (const plugin of setup) await harness.mount(plugin);
    return harness;
  } catch (error) {
    await harness.dispose();
    throw error;
  }
}
