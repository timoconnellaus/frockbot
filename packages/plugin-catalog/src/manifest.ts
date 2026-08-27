export type ContributionKind = "agent" | "desktop" | "mobile" | "web";

export interface WebContribution {
  entry: string;
  manifest: string;
  slots: string[];
}

export interface FrockBotManifestV1 {
  schemaVersion: 1;
  id: string;
  displayName: string;
  version: string;
  contributions: {
    agent?: string;
    desktop?: string;
    mobile?: string;
    web?: WebContribution;
  };
  permissions: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`manifest field "${key}" must be a non-empty string`);
  }
  return value;
}

function optionalEntry(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.startsWith("./")) {
    throw new Error(
      `manifest contribution "${key}" must be a relative export path`,
    );
  }
  return value;
}

export function decodeFrockBotManifest(value: unknown): FrockBotManifestV1 {
  if (!isRecord(value)) throw new Error("manifest must be an object");
  if (value.schemaVersion !== 1)
    throw new Error("unsupported FrockBot manifest version");
  const id = requiredString(value, "id");
  if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    throw new Error("manifest id must be lowercase kebab-case");
  }
  if (!isRecord(value.contributions)) {
    throw new Error("manifest contributions must be an object");
  }
  const agent = optionalEntry(value.contributions, "agent");
  const desktop = optionalEntry(value.contributions, "desktop");
  const mobile = optionalEntry(value.contributions, "mobile");
  let web: WebContribution | undefined;
  if (value.contributions.web !== undefined) {
    if (!isRecord(value.contributions.web)) {
      throw new Error("manifest web contribution must be an object");
    }
    const slots = value.contributions.web.slots;
    if (
      !Array.isArray(slots) ||
      !slots.every((slot) => typeof slot === "string")
    ) {
      throw new Error("manifest web slots must be strings");
    }
    web = {
      entry: requiredString(value.contributions.web, "entry"),
      manifest: requiredString(value.contributions.web, "manifest"),
      slots: [...slots],
    };
  }
  if (!agent && !desktop && !mobile && !web)
    throw new Error("manifest has no contributions");
  const permissions = value.permissions ?? [];
  if (
    !Array.isArray(permissions) ||
    !permissions.every(
      (permission) => typeof permission === "string" && permission.length > 0,
    )
  ) {
    throw new Error("manifest permissions must be non-empty strings");
  }
  return {
    schemaVersion: 1,
    id,
    displayName: requiredString(value, "displayName"),
    version: requiredString(value, "version"),
    contributions: { agent, desktop, mobile, web },
    permissions: [...permissions],
  };
}

export function declaredContributionKinds(
  manifest: FrockBotManifestV1,
): ContributionKind[] {
  const kinds: ContributionKind[] = [];
  if (manifest.contributions.agent) kinds.push("agent");
  if (manifest.contributions.desktop) kinds.push("desktop");
  if (manifest.contributions.mobile) kinds.push("mobile");
  if (manifest.contributions.web) kinds.push("web");
  return kinds;
}
