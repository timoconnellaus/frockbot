import type { Context } from "cordis";
import {
  type ContributionResolver,
  LocalCordisContributionHost,
  type PackageCatalogConfig,
} from "./index.ts";

export const runtimePackageCatalogConfig: PackageCatalogConfig = {
  kinds: ["runtime"],
};

export function createRuntimeContributionHost(
  ctx: Context,
  resolve: ContributionResolver,
): LocalCordisContributionHost {
  return new LocalCordisContributionHost("runtime", ctx, resolve);
}
