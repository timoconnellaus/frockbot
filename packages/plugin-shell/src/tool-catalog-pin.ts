/** External schemas are an admitted Turn's inputs, owned by its Bot. */
interface ToolCatalogPinTransaction {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<unknown>;
}
export interface ToolCatalogPinStorage extends ToolCatalogPinTransaction {
  transaction<T>(
    callback: (tx: ToolCatalogPinTransaction) => Promise<T>,
  ): Promise<T>;
}

export function turnToolCatalogPin(
  storage: ToolCatalogPinStorage,
  turnId: string,
) {
  return async (
    connectionId: string,
    read: () => Promise<unknown>,
  ): Promise<unknown> => {
    const key = `shell:turn-tool-catalog:v1:${turnId}:${connectionId}`;
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
    if (
      new TextEncoder().encode(JSON.stringify(catalog)).byteLength > 1_000_000
    )
      throw new Error("The Turn's tool catalog exceeds its limit");
    return storage.transaction(async (tx) => {
      const concurrent = await tx.get<unknown>(key);
      if (concurrent !== undefined) return decode(concurrent);
      await tx.put(key, { schemaVersion: 1, catalog });
      return catalog;
    });
  };
}
