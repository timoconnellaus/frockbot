/** Dispose a resource that finishes starting after its owner has shut down. */
export async function retainStartedResource<
  T extends { dispose(): Promise<void> },
>(pending: Promise<T>, isDisposed: () => boolean): Promise<T | undefined> {
  const resource = await pending;
  if (!isDisposed()) return resource;
  await resource.dispose();
  return undefined;
}

/** Own one idempotent shutdown path for the Vue projection and Cordis host. */
export function createOwnedMobileDisposer(
  unmount: () => void,
  disposeHost: () => Promise<void>,
): () => Promise<void> {
  let result: Promise<void> | undefined;
  return () => {
    if (result) return result;
    unmount();
    result = disposeHost();
    return result;
  };
}
