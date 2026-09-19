export interface PackageCatalogIdentityV1 {
  packageId: string;
  version?: string;
}

export interface PackageCatalogIndexV1<T> {
  readonly entries: readonly T[];
  get(packageId: string, version?: string): T | undefined;
  has(packageId: string, version?: string): boolean;
}

/** Index one deployment's Package catalog, where each Package id is unique. */
export function indexPackageCatalogV1<T>(
  entries: readonly T[],
  identity: (entry: T) => PackageCatalogIdentityV1,
): PackageCatalogIndexV1<T> {
  const indexedEntries = [...entries];
  const byPackageId = new Map<
    string,
    { entry: T; identity: PackageCatalogIdentityV1 }
  >();
  for (const entry of indexedEntries) {
    const entryIdentity = identity(entry);
    if (byPackageId.has(entryIdentity.packageId)) {
      throw new Error(
        `Package catalog contains duplicate Package id "${entryIdentity.packageId}"`,
      );
    }
    byPackageId.set(entryIdentity.packageId, {
      entry,
      identity: entryIdentity,
    });
  }
  const get = (packageId: string, version?: string): T | undefined => {
    const indexed = byPackageId.get(packageId);
    if (
      !indexed ||
      (version !== undefined && indexed.identity.version !== version)
    )
      return undefined;
    return indexed.entry;
  };
  return {
    entries: indexedEntries,
    get,
    has: (packageId, version) => get(packageId, version) !== undefined,
  };
}
