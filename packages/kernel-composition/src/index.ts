import type { ArtifactRefV1 } from "./generation.ts";
import type { ContributionKind, FrockBotManifest } from "./manifest.ts";

export * from "./manifest.ts";
export type { ArtifactRefV1 } from "./generation.ts";

export interface PackageDescriptor {
  specifier: string;
  manifest: FrockBotManifest;
  /**
   * Present only for a Composition member that carries an immutable,
   * content-addressed artifact — that is, a Package whose provenance is not
   * first-party and which therefore runs in a Bot isolate.
   */
  artifact?: ArtifactRefV1;
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
