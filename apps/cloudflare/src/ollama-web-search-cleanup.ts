// Disposable pre-user cleanup for the retired Ollama web search.
//
// Web search is the Web Package's now, on the platform's own key. The Ollama
// Package's `web-search-max-results` setting capped the search it retired, and
// its value sits on that Package's installation row in `user-configuration`.
// Resolution already ignores a value no manifest declares, so this removes a
// dead value from the row a client reads back rather than repairing a read.
// The `ollama-cloud-web-search` Capability was never stored: a Package's
// enabled Capabilities are derived from its definition, so nothing else is
// left. The receipt makes a second load free.

const USER_CONFIGURATION_KEY = "user-configuration";
const OLLAMA_PACKAGE_ID = "provider-ollama-cloud";
const RETIRED_SETTING_ID = "web-search-max-results";
export const OLLAMA_WEB_SEARCH_CLEANUP_RECEIPT_KEY =
  "maintenance:ollama-web-search:2026-09-24";

type Stored = Record<string, unknown>;

function record(value: unknown): Stored | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return value as Stored;
}

/** The settings without the retired value, or `undefined` to keep them. */
export function withoutRetiredWebSearchSettingV1(
  stored: unknown,
): Stored | undefined {
  const settings = record(stored);
  if (!settings || !Array.isArray(settings.packages)) return undefined;
  let changed = false;
  const packages = settings.packages.map((entry) => {
    const installation = record(entry);
    const values = record(installation?.values);
    if (
      !installation ||
      !values ||
      installation.packageId !== OLLAMA_PACKAGE_ID ||
      !Object.hasOwn(values, RETIRED_SETTING_ID)
    ) {
      return entry;
    }
    changed = true;
    const { [RETIRED_SETTING_ID]: _retired, ...kept } = values;
    const { values: _values, ...rest } = installation;
    // The settings writer omits an empty bag, so the cleanup does too.
    return Object.keys(kept).length > 0 ? { ...rest, values: kept } : rest;
  });
  return changed ? { ...settings, packages } : undefined;
}

export async function cleanRetiredOllamaWebSearchV1(
  storage: DurableObjectStorage,
  now: Date = new Date(),
): Promise<void> {
  if (await storage.get(OLLAMA_WEB_SEARCH_CLEANUP_RECEIPT_KEY)) return;
  await storage.transaction(async (tx) => {
    if (await tx.get(OLLAMA_WEB_SEARCH_CLEANUP_RECEIPT_KEY)) return;
    const cleaned = withoutRetiredWebSearchSettingV1(
      await tx.get<unknown>(USER_CONFIGURATION_KEY),
    );
    if (cleaned) await tx.put(USER_CONFIGURATION_KEY, cleaned);
    await tx.put(OLLAMA_WEB_SEARCH_CLEANUP_RECEIPT_KEY, {
      at: now.toISOString(),
      removed: cleaned !== undefined,
    });
  });
}
