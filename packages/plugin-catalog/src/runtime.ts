import type { Context } from "cordis";
import {
  type ContributionResolver,
  LocalCordisContributionHost,
  type PackageCatalogConfig,
} from "./index.ts";

// Runtime hosts accept only canonical run-scoped contributions.
export const runtimePackageCatalogConfig: PackageCatalogConfig = {
  kinds: ["runtime"],
};

export function createRuntimeContributionHost(
  ctx: Context,
  resolve: ContributionResolver,
): LocalCordisContributionHost {
  return new LocalCordisContributionHost("runtime", ctx, resolve);
}
