/**
 * External schemas are an admitted Turn's inputs, owned by its Bot.
 *
 * A Turn that mounts a Connection's tools reads that provider's catalog once
 * and pins it, so the Turn keeps the exact schemas and versions it was
 * admitted under however many times its Durable Object is evicted and its
 * Composition remounted mid-run. A later Turn reads the provider again and
 * sees whatever the provider has since published.
 *
 * The pins are durable state, so they are bounded state. Three bounds, all
 * enforced here and all durable:
 *
 *  * **One pin.** A single Connection's catalog may not exceed
 *    {@link TURN_TOOL_CATALOG_PIN_BYTES_V1}.
 *  * **All pins together.** Every retained pin's encoded bytes are accounted
 *    in a durable index and may not exceed
 *    {@link TURN_TOOL_CATALOG_TOTAL_BYTES_V1}.
 *  * **How many Turns keep one.** At most
 *    {@link TURN_TOOL_CATALOG_TURN_RETENTION_V1} Turns hold pins; older Turns
 *    are reclaimed oldest-first.
 *
 * Reclaiming an older Turn's pin costs nothing that is not recorded elsewhere:
 * the durable session event log holds each `model/request` verbatim, tool
 * catalog included, so the exact normalized request of a settled Turn is
 * reconstructed from the log rather than from a pin. The pin exists for a Turn
 * that is still *running*, and the Turn writing one is never reclaimed to make
 * room for itself.
 *
 * When even an empty store cannot hold what one Turn is asking to pin, the
 * write is refused with a visible error rather than filling the object until
 * an unrelated admission, event, or settlement write is the one that fails.
 */

/** The key one Turn's pinned catalog for one Connection lives under. */
export const TURN_TOOL_CATALOG_PIN_PREFIX_V1 = "shell:turn-tool-catalog:v1:";
/** The durable account of every retained pin and what it costs. */
export const TURN_TOOL_CATALOG_INDEX_KEY_V1 =
  "shell:turn-tool-catalog-index:v1";
/** Largest one Connection's catalog may encode to for one Turn. */
export const TURN_TOOL_CATALOG_PIN_BYTES_V1 = 1_000_000;
/** Largest every retained pin may encode to together. */
export const TURN_TOOL_CATALOG_TOTAL_BYTES_V1 = 8_000_000;
/** How many Turns keep pinned catalogs before the oldest is reclaimed. */
export const TURN_TOOL_CATALOG_TURN_RETENTION_V1 = 16;

interface ToolCatalogPinTransaction {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}
export interface ToolCatalogPinStorage extends ToolCatalogPinTransaction {
  transaction<T>(
    callback: (tx: ToolCatalogPinTransaction) => Promise<T>,
  ): Promise<T>;
}

/** One retained pin, in the order it was written. */
interface ToolCatalogPinEntryV1 {
  turnId: string;
  connectionId: string;
  bytes: number;
}

interface ToolCatalogPinIndexV1 {
  schemaVersion: 1;
  entries: ToolCatalogPinEntryV1[];
}

export function turnToolCatalogPinKeyV1(
  turnId: string,
  connectionId: string,
): string {
  return `${TURN_TOOL_CATALOG_PIN_PREFIX_V1}${turnId}:${connectionId}`;
}

/**
 * The index as durable state says it is. An unreadable or absent index is read
 * as empty: it is an account of pins, not the pins themselves, so a Turn is
 * never refused because the account could not be parsed. Reclamation then
 * rebuilds it from what it writes.
 */
function decodeIndexV1(value: unknown): ToolCatalogPinIndexV1 {
  if (
    !value ||
    typeof value !== "object" ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== 1 ||
    !("entries" in value) ||
    !Array.isArray(value.entries)
  )
    return { schemaVersion: 1, entries: [] };
  const entries = value.entries.filter(
    (entry): entry is ToolCatalogPinEntryV1 =>
      !!entry &&
      typeof entry === "object" &&
      typeof (entry as ToolCatalogPinEntryV1).turnId === "string" &&
      typeof (entry as ToolCatalogPinEntryV1).connectionId === "string" &&
      Number.isFinite((entry as ToolCatalogPinEntryV1).bytes),
  );
  return { schemaVersion: 1, entries };
}

function totalBytes(entries: readonly ToolCatalogPinEntryV1[]): number {
  return entries.reduce((sum, entry) => sum + entry.bytes, 0);
}

function turnCount(
  entries: readonly ToolCatalogPinEntryV1[],
  turnId: string,
): number {
  return new Set([...entries.map((entry) => entry.turnId), turnId]).size;
}

/**
 * Makes room for `bytes` of one Turn's catalog, oldest Turn first, and says
 * what the index becomes. Entries belonging to `turnId` are never reclaimed:
 * a Turn cannot evict the schemas it is running on to make room for more of
 * its own.
 */
async function reclaimForV1(
  tx: ToolCatalogPinTransaction,
  entries: ToolCatalogPinEntryV1[],
  turnId: string,
  bytes: number,
): Promise<ToolCatalogPinEntryV1[]> {
  let retained = entries;
  const overBudget = () =>
    totalBytes(retained) + bytes > TURN_TOOL_CATALOG_TOTAL_BYTES_V1 ||
    turnCount(retained, turnId) > TURN_TOOL_CATALOG_TURN_RETENTION_V1;
  while (overBudget()) {
    const oldest = retained.find((entry) => entry.turnId !== turnId);
    if (!oldest) break;
    // Every entry of the oldest Turn goes together: half a Turn's catalogs is
    // not a state any Turn was admitted under.
    const reclaimed = retained.filter(
      (entry) => entry.turnId === oldest.turnId,
    );
    retained = retained.filter((entry) => entry.turnId !== oldest.turnId);
    for (const entry of reclaimed)
      await tx.delete(
        turnToolCatalogPinKeyV1(entry.turnId, entry.connectionId),
      );
  }
  if (overBudget())
    throw new Error("The Turn's tool catalogs exceed their durable limit");
  return retained;
}

export function turnToolCatalogPin(
  storage: ToolCatalogPinStorage,
  turnId: string,
) {
  return async (
    connectionId: string,
    read: () => Promise<unknown>,
  ): Promise<unknown> => {
    const key = turnToolCatalogPinKeyV1(turnId, connectionId);
    const decode = (value: unknown): unknown => {
      if (
        !value ||
        typeof value !== "object" ||
        !("schemaVersion" in value) ||
        value.schemaVersion !== 1 ||
        !("catalog" in value)
      )
        throw new Error("The Turn's tool catalog is unavailable");
      return value.catalog;
    };
    const previous = await storage.get<unknown>(key);
    if (previous !== undefined) return decode(previous);
    const catalog = await read();
    const stored = { schemaVersion: 1, catalog };
    const bytes = new TextEncoder().encode(JSON.stringify(stored)).byteLength;
    if (bytes > TURN_TOOL_CATALOG_PIN_BYTES_V1)
      throw new Error("The Turn's tool catalog exceeds its limit");
    return storage.transaction(async (tx) => {
      const concurrent = await tx.get<unknown>(key);
      if (concurrent !== undefined) return decode(concurrent);
      const index = decodeIndexV1(
        await tx.get<unknown>(TURN_TOOL_CATALOG_INDEX_KEY_V1),
      );
      const retained = await reclaimForV1(
        tx,
        index.entries.filter(
          (entry) =>
            entry.turnId !== turnId || entry.connectionId !== connectionId,
        ),
        turnId,
        bytes,
      );
      await tx.put(key, stored);
      await tx.put(TURN_TOOL_CATALOG_INDEX_KEY_V1, {
        schemaVersion: 1,
        entries: [...retained, { turnId, connectionId, bytes }],
      } satisfies ToolCatalogPinIndexV1);
      return catalog;
    });
  };
}
