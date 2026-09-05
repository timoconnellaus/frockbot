// Released v0.3.39 model policy, d548e550. Kept as a historical reader fixture.
// Only its exported name/import paths differ; do not evolve it with the current policy.
import {
  resolveBotModelBindingV1,
  type BotSettingsViewV1,
  type UserSettingsViewV1,
  type ExecutionPackageDefinition,
  type EffectiveBotModelV1,
  type PackageInstallationView,
  type ModelBindingV1,
  type ResolvedModelBindingV1,
} from "../../../configuration-core/src/index.js";
import { resolvePackageSettingValuesV1 } from "../../../configuration-core/src/package-settings.js";
import type { PackageSettingDefinition } from "@frockbot/kernel-composition";
function compareIdentifiers(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function resolveReleasedModelPolicy(input: {
  bot: Pick<BotSettingsViewV1, "packageValues">;
  user: UserSettingsViewV1;
  packages: readonly ExecutionPackageDefinition[];
}): EffectiveBotModelV1 {
  const enabled = input.user.packages
    .filter((installation) => installation.state === "installed")
    .map((installation) => ({
      installation,
      pkg: input.packages.find(
        (candidate) =>
          candidate.packageId === installation.packageId &&
          candidate.version === installation.version,
      ),
    }))
    .filter(
      (
        candidate,
      ): candidate is {
        installation: PackageInstallationView;
        pkg: ExecutionPackageDefinition;
      } => candidate.pkg !== undefined,
    );

  const fromScope = (
    scope: "user" | "bot",
  ): { model?: ModelBindingV1; conflict?: string } | undefined => {
    const declarations = enabled
      .map(({ installation, pkg }) => ({
        installation,
        pkg,
        definition: pkg.settings
          .filter(
            (definition) =>
              definition.role === "model" && definition.scopes.includes(scope),
          )
          .sort((left, right) => compareIdentifiers(left.id, right.id))[0],
      }))
      .filter(
        (
          candidate,
        ): candidate is typeof candidate & {
          definition: PackageSettingDefinition;
        } => candidate.definition !== undefined,
      )
      .sort((left, right) =>
        compareIdentifiers(left.pkg.packageId, right.pkg.packageId),
      );
    if (declarations.length > 1) {
      const names = declarations.map(({ pkg }) => `"${pkg.packageId}"`);
      return {
        conflict:
          "Two plugins are both set as your model. Turn one off in Plugins.",
      };
    }
    const declaration = declarations[0];
    if (!declaration) return undefined;
    const stored =
      scope === "bot"
        ? Object.hasOwn(input.bot.packageValues, declaration.pkg.packageId)
          ? input.bot.packageValues[declaration.pkg.packageId]
          : undefined
        : declaration.installation.values;
    const value = resolvePackageSettingValuesV1(
      declaration.pkg.settings,
      stored,
      scope,
    )[declaration.definition.id];
    return {
      ...(typeof value === "object" && value !== null ? { model: value } : {}),
    };
  };

  /**
   * A chosen model whose provider Package has been switched off, or whose
   * Connection is gone, must not stop the Bot answering: the platform
   * bootstrap stands in for it. Only a binding failure degrades this way — a
   * scope conflict is the User's own contradiction and still fails closed,
   * because there is no single choice to stand in for.
   */
  const platformStandIn = (
    from: "bot" | "account",
    model: ModelBindingV1,
    binding: ResolvedModelBindingV1,
  ): EffectiveBotModelV1 | undefined => {
    const platform = input.user.platformModel;
    if (!platform) return undefined;
    if (
      platform.connectionId === model.connectionId &&
      platform.providerModelId === model.providerModelId
    ) {
      return undefined;
    }
    const platformBinding = resolveBotModelBindingV1({
      model: platform,
      user: input.user,
      packages: input.packages,
    });
    if (platformBinding.state === "unavailable") return undefined;
    return {
      source: "platform",
      model: structuredClone(platform),
      binding: platformBinding,
      fallback: {
        from,
        model: structuredClone(model),
        failure:
          binding.failure ?? "This Bot's model isn't available right now.",
      },
    };
  };

  for (const scope of ["bot", "user"] as const) {
    const resolved = fromScope(scope);
    const source = scope === "bot" ? "bot" : "account";
    if (resolved?.conflict) {
      return {
        source,
        binding: { state: "unavailable", failure: resolved.conflict },
      };
    }
    if (resolved?.model) {
      const binding = resolveBotModelBindingV1({
        model: resolved.model,
        user: input.user,
        packages: input.packages,
      });
      if (binding.state === "unavailable") {
        const standIn = platformStandIn(source, resolved.model, binding);
        if (standIn) return standIn;
      }
      return {
        source,
        model: structuredClone(resolved.model),
        binding,
      };
    }
  }

  const model = input.user.platformModel;
  if (!model) return { source: "none" };
  return {
    source: "platform",
    model: structuredClone(model),
    binding: resolveBotModelBindingV1({
      model,
      user: input.user,
      packages: input.packages,
    }),
  };
}
