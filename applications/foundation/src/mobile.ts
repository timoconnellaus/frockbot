import mobileClipboardManifest from "@frockbot/plugin-mobile-clipboard/manifest";
import mobileNotificationsManifest from "@frockbot/plugin-mobile-notifications/manifest";
import applicationJson from "../frockbot.application.json" with { type: "json" };

export interface FoundationMobilePackage {
  specifier: string;
  manifest: unknown;
}

const mobileManifests = new Map<string, unknown>([
  [
    "@frockbot/plugin-mobile-clipboard",
    structuredClone(mobileClipboardManifest),
  ],
  [
    "@frockbot/plugin-mobile-notifications",
    structuredClone(mobileNotificationsManifest),
  ],
]);
const declaredSpecifiers = new Set(
  applicationJson.packages.map(({ specifier }) => specifier),
);

/** Mobile Contributions selected by the immutable compiled application order. */
export const foundationMobilePackages: readonly FoundationMobilePackage[] = [
  "@frockbot/plugin-mobile-clipboard",
  "@frockbot/plugin-mobile-notifications",
].flatMap((specifier) => {
  const manifest = mobileManifests.get(specifier);
  return manifest !== undefined && declaredSpecifiers.has(specifier)
    ? [{ specifier, manifest }]
    : [];
});
