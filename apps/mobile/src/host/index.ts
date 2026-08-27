import {
  decodeMobileShareRequest,
  MobileCommandRegistry,
  type MobileCommandResult,
  type MobileCommandSummary,
  type MobileShareRequest,
} from "@frockbot/mobile-core";
import {
  type ContributionResolver,
  LocalCordisContributionHost,
  PackageCatalog,
} from "@frockbot/plugin-catalog";
import mobileClipboardPlugin from "@frockbot/plugin-mobile-clipboard/mobile";
import mobileClipboardManifest from "@frockbot/plugin-mobile-clipboard/manifest";
import mobileNotificationsPlugin from "@frockbot/plugin-mobile-notifications/mobile";
import mobileNotificationsManifest from "@frockbot/plugin-mobile-notifications/manifest";
import { Context } from "cordis";
import type { MobilePlatformAdapters } from "./adapters.ts";
import {
  createClipboardProvider,
  createNotificationProvider,
  createShareProvider,
} from "./capabilities.ts";

export * from "./adapters.ts";

export const CLIPBOARD_PACKAGE = "@frockbot/plugin-mobile-clipboard";
export const NOTIFICATIONS_PACKAGE = "@frockbot/plugin-mobile-notifications";

const BUILT_IN_CONTRIBUTIONS = new Map<string, unknown>([
  [`${NOTIFICATIONS_PACKAGE}/mobile`, { default: mobileNotificationsPlugin }],
  [`${CLIPBOARD_PACKAGE}/mobile`, { default: mobileClipboardPlugin }],
]);

export const resolveBuiltInMobileContribution: ContributionResolver = (
  specifier,
) => {
  const contribution = BUILT_IN_CONTRIBUTIONS.get(specifier);
  if (!contribution) {
    return Promise.reject(
      new Error(`unknown built-in contribution: ${specifier}`),
    );
  }
  return Promise.resolve(contribution);
};

export interface MobileHostPackage {
  specifier: string;
  manifest: unknown;
}

export const BUILT_IN_MOBILE_PACKAGES: readonly MobileHostPackage[] = [
  { specifier: NOTIFICATIONS_PACKAGE, manifest: mobileNotificationsManifest },
  { specifier: CLIPBOARD_PACKAGE, manifest: mobileClipboardManifest },
];

export interface MobileHostOptions {
  adapters: MobilePlatformAdapters;
  packages?: readonly MobileHostPackage[];
  resolveContribution?: ContributionResolver;
}

export interface MobileHost {
  invoke<Output extends MobileCommandResult = MobileCommandResult>(
    commandId: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<Output>;
  list(): MobileCommandSummary[];
  share(request: MobileShareRequest, signal?: AbortSignal): Promise<void>;
  dispose(): Promise<void>;
}

export async function createMobileHost(
  options: MobileHostOptions,
): Promise<MobileHost> {
  const root = new Context();
  try {
    await root.plugin(MobileCommandRegistry);
    await root.plugin(createNotificationProvider(options.adapters.notifications));
    await root.plugin(createClipboardProvider(options.adapters.clipboard));
    await root.plugin(createShareProvider(options.adapters.share));
    await root.plugin(PackageCatalog, { kinds: ["mobile"] });

    root.packages.registerHost(
      new LocalCordisContributionHost(
        "mobile",
        root,
        options.resolveContribution ?? resolveBuiltInMobileContribution,
      ),
    );

    for (const pkg of options.packages ?? BUILT_IN_MOBILE_PACKAGES) {
      const installed = root.packages.install(pkg);
      await root.packages.enable(installed.manifest.id);
    }
  } catch (error) {
    await root.fiber.dispose();
    throw error;
  }

  let disposed = false;
  return {
    async invoke<Output extends MobileCommandResult = MobileCommandResult>(
      commandId: string,
      input: unknown,
      signal?: AbortSignal,
    ): Promise<Output> {
      if (disposed) {
        throw new Error(`mobile command "${commandId}" is unavailable`);
      }
      return await root.mobileCommands.invoke<Output>(commandId, input, signal);
    },
    list: () => (disposed ? [] : root.mobileCommands.list()),
    async share(
      request: MobileShareRequest,
      signal?: AbortSignal,
    ): Promise<void> {
      if (disposed) throw new Error("the mobile host is disposed");
      await root.mobileShare.share(
        decodeMobileShareRequest(request),
        signal ?? new AbortController().signal,
      );
    },
    async dispose(): Promise<void> {
      disposed = true;
      await root.fiber.dispose();
    },
  };
}
