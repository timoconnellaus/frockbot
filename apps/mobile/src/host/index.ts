import {
  MobileCommandRegistry,
  type MobileCommandResult,
  type MobileCommandSummary,
} from "@frockbot/mobile-core";
import {
  type ContributionResolver,
  LocalCordisContributionHost,
  PackageCatalog,
} from "@frockbot/plugin-catalog";
import mobileClipboardPlugin from "@frockbot/plugin-mobile-clipboard/mobile";
import mobileNotificationsPlugin from "@frockbot/plugin-mobile-notifications/mobile";
import { Context } from "cordis";
import type { MobilePlatformAdapters } from "./adapters.ts";
import {
  createClipboardProvider,
  createNotificationProvider,
} from "./capabilities.ts";

export * from "./adapters.ts";

export const CLIPBOARD_PACKAGE = "@frockbot/plugin-mobile-clipboard";
export const NOTIFICATIONS_PACKAGE = "@frockbot/plugin-mobile-notifications";

const BUILT_IN_CONTRIBUTIONS = new Map<string, unknown>([
  [`${NOTIFICATIONS_PACKAGE}/mobile`, { default: mobileNotificationsPlugin }],
  [`${CLIPBOARD_PACKAGE}/mobile`, { default: mobileClipboardPlugin }],
]);

/** Resolves only implementations shipped by this mobile shell. */
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

export interface MobileHostOptions {
  adapters: MobilePlatformAdapters;
  /** Exact immutable-application declaration order. */
  packages: readonly MobileHostPackage[];
  resolveContribution?: ContributionResolver;
}

export interface MobileHost {
  invoke<Output extends MobileCommandResult = MobileCommandResult>(
    commandId: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<Output>;
  list(): MobileCommandSummary[];
  dispose(): Promise<void>;
}

export async function createMobileHost(
  options: MobileHostOptions,
): Promise<MobileHost> {
  const root = new Context();
  try {
    await root.plugin(MobileCommandRegistry);
    await root.plugin(
      createNotificationProvider(options.adapters.notifications),
    );
    await root.plugin(createClipboardProvider(options.adapters.clipboard));
    await root.plugin(PackageCatalog, { kinds: ["mobile"] });

    root.packages.registerHost(
      new LocalCordisContributionHost(
        "mobile",
        root,
        options.resolveContribution ?? resolveBuiltInMobileContribution,
      ),
    );

    for (const pkg of options.packages) {
      const installed = root.packages.install({
        specifier: pkg.specifier,
        manifest: structuredClone(pkg.manifest),
      });
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
    async dispose(): Promise<void> {
      disposed = true;
      await root.fiber.dispose();
    },
  };
}
