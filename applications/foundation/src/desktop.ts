import type { ApplicationDeclarationPlan } from "@frockbot/kernel-composition/compiler";
import authPlugin from "@frockbot/plugin-auth/desktop";
import clockHostPlugin from "@frockbot/plugin-clock/host";
import clipboardPlugin from "@frockbot/plugin-desktop-clipboard/desktop";
import directoryPickerPlugin from "@frockbot/plugin-desktop-directory-picker/desktop";
import notificationsPlugin from "@frockbot/plugin-desktop-notifications/desktop";
import flySpriteHostPlugin from "@frockbot/plugin-fly-sprite/host";
import type { Plugin } from "cordis";

const trustedDesktopPlugins = new Map<string, Plugin>([
  ["@frockbot/plugin-auth/desktop", authPlugin],
  ["@frockbot/plugin-clock/host", clockHostPlugin],
  ["@frockbot/plugin-desktop-notifications/desktop", notificationsPlugin],
  ["@frockbot/plugin-desktop-directory-picker/desktop", directoryPickerPlugin],
  ["@frockbot/plugin-desktop-clipboard/desktop", clipboardPlugin],
  ["@frockbot/plugin-fly-sprite/host", flySpriteHostPlugin],
]);

export interface FoundationTrustedDesktopContribution {
  packageId: string;
  contributionSpecifier: string;
  plugin: Plugin;
}

export function resolveFoundationTrustedDesktopContribution(
  plan: ApplicationDeclarationPlan,
  packageId: string,
): FoundationTrustedDesktopContribution {
  if (!plan.contributions.desktop.includes(packageId)) {
    throw new Error(
      `foundation desktop package "${packageId}" is not declared by the application`,
    );
  }
  const pkg = plan.packages.find((candidate) => candidate.id === packageId);
  const contribution = pkg?.manifest.contributions.desktop;
  if (!pkg || !contribution) {
    throw new Error(
      `foundation desktop package "${packageId}" has no Contribution`,
    );
  }
  if (contribution.execution !== "trusted-main") {
    throw new Error(
      `foundation desktop package "${packageId}" is not trusted for Electron main`,
    );
  }
  const contributionSpecifier = `${pkg.specifier}${contribution.entry.slice(1)}`;
  const plugin = trustedDesktopPlugins.get(contributionSpecifier);
  if (!plugin) {
    throw new Error(
      `unknown foundation desktop contribution: ${contributionSpecifier}`,
    );
  }
  return { packageId, contributionSpecifier, plugin };
}
