/**
 * Reuses successful immutable work in a bounded insertion-ordered cache.
 * Hits are touched, and failures are removed so transient reads stay
 * retryable. The caller owns the cache and chooses the identity boundary.
 */
export function boundedPromiseCacheV1<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  limit: number,
  load: () => Promise<T>,
): Promise<T> {
  const held = cache.get(key);
  if (held) {
    cache.delete(key);
    cache.set(key, held);
    return held;
  }

  const loading = load();
  cache.set(key, loading);
  while (cache.size > limit) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  void loading.catch(() => {
    if (cache.get(key) === loading) cache.delete(key);
  });
  return loading;
}
