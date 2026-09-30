/**
 * The account as the page holds it: read once when the page opens, and again
 * after every change, since the authority's answer is the only truth.
 */

import { createContext } from "preact";
import { useCallback, useContext, useEffect, useState } from "preact/hooks";
import { api } from "./api.ts";
import { onHost } from "./bridge.ts";
import type {
  Billing,
  CatalogAccount,
  CatalogRow,
  ConnectionsFrame,
  Settings,
  Spending,
  WebSearchChoice,
} from "./model.ts";

export interface SetupData {
  settings: Settings;
  /** Every model provider the product offers, added or not. */
  modelCatalog: CatalogRow[];
  /** Every account the person holds, in the Connections frame's words. */
  accounts: CatalogAccount[];
  /** Absent where this install sells nothing, or while billing is down. */
  billing?: Billing;
  spending?: Spending;
  /** Absent while it cannot be read; the page then says so. */
  webSearch?: WebSearchChoice;
  /** Credit used in the last 30 days, for the plan suggestion. */
  spentLast30DaysMicros?: number;
}

export type Loaded =
  | { state: "loading" }
  | { state: "signed-out" }
  | { state: "failed"; message: string }
  | { state: "ready"; data: SetupData };

async function optional<T>(read: Promise<T>): Promise<T | undefined> {
  try {
    return await read;
  } catch {
    return undefined;
  }
}

export async function loadSetup(): Promise<SetupData> {
  const [settings, models, installed, billing, webSearch] = await Promise.all([
    api<Settings>("/api/settings?view=2"),
    api<ConnectionsFrame>(
      "/api/settings/connections?catalog=1&kinds=model&limit=2000",
    ),
    api<ConnectionsFrame>("/api/settings/connections"),
    optional(api<Billing & { spentLast30DaysMicros?: number }>("/api/billing")),
    optional(api<WebSearchChoice>("/api/web-search")),
  ]);
  const spending = billing?.metered
    ? await optional(
        api<Spending>(
          `/api/billing/spending?period=${billing.subscribed ? "billing" : "30d"}&groupBy=category`,
        ),
      )
    : undefined;
  return {
    settings,
    modelCatalog: models.providers,
    accounts: installed.accounts,
    ...(billing ? { billing } : {}),
    ...(spending ? { spending } : {}),
    ...(webSearch ? { webSearch } : {}),
    ...(billing?.spentLast30DaysMicros === undefined
      ? {}
      : { spentLast30DaysMicros: billing.spentLast30DaysMicros }),
  };
}

export function useSetupLoader(): {
  loaded: Loaded;
  reload: () => Promise<void>;
} {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const reload = useCallback(async () => {
    try {
      setLoaded({ state: "ready", data: await loadSetup() });
    } catch (error) {
      const status = (error as { status?: number }).status;
      setLoaded(
        status === 401
          ? { state: "signed-out" }
          : {
              state: "failed",
              message:
                error instanceof Error ? error.message : "Setup couldn’t load.",
            },
      );
    }
  }, []);
  useEffect(() => {
    void reload();
    const again = () => {
      if (document.visibilityState === "visible") void reload();
    };
    document.addEventListener("visibilitychange", again);
    const stop = onHost((message) => {
      if (message.type === "refresh") void reload();
    });
    return () => {
      document.removeEventListener("visibilitychange", again);
      stop();
    };
  }, [reload]);
  return { loaded, reload };
}

export const SetupContext = createContext<{
  data: SetupData;
  reload: () => Promise<void>;
  go: (page: string) => void;
} | null>(null);

export function useSetup() {
  const value = useContext(SetupContext);
  if (!value) throw new Error("Setup is not loaded");
  return value;
}
