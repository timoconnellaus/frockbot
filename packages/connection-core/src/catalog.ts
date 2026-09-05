/** Named, non-authoritative variants of a Package-declared Connection Type. */
export interface ConnectorCatalogEntryV1 {
  id: string;
  name: string;
  description: string;
  icon?: string;
}

export function decodeConnectorCatalogV1(
  value: unknown,
): ConnectorCatalogEntryV1[] {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Connector catalog is unavailable");
  const view = value as Record<string, unknown>;
  if (
    view.schemaVersion !== 1 ||
    !Array.isArray(view.items) ||
    view.items.length > 1000
  )
    throw new Error("Connector catalog is unavailable");
  const ids = new Set<string>();
  return view.items.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("Connector is invalid");
    const row = item as Record<string, unknown>;
    if (
      typeof row.id !== "string" ||
      !/^[a-z0-9][a-z0-9_-]{0,99}$/.test(row.id) ||
      ids.has(row.id) ||
      typeof row.name !== "string" ||
      !row.name.trim() ||
      row.name.length > 120 ||
      typeof row.description !== "string" ||
      row.description.length > 500
    )
      throw new Error("Connector is invalid");
    ids.add(row.id);
    if (
      row.icon !== undefined &&
      (typeof row.icon !== "string" ||
        row.icon.length > 2048 ||
        new URL(row.icon).protocol !== "https:")
    )
      throw new Error("Connector icon is invalid");
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      ...(typeof row.icon === "string" ? { icon: row.icon } : {}),
    };
  });
}
