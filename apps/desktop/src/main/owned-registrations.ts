export type OwnedRegistration = () => void | (() => void);

export interface DisposableAuthMainClient<T> {
  setupMain(config: {
    csp: false;
    bridges: false;
    scheme: false;
    getWindow(): T;
  }): void;
}

export function setupDisposableAuthMain<T>(
  client: DisposableAuthMainClient<T>,
  isReady: boolean,
  getWindow: () => T,
): void {
  if (isReady) {
    throw new Error("desktop authentication must mount before app ready");
  }
  client.setupMain({
    csp: false,
    bridges: false,
    scheme: false,
    getWindow,
  });
}

export function mountOwnedRegistrations(
  registrations: readonly OwnedRegistration[],
): () => void {
  const cleanups: Array<() => void> = [];
  let mounted = true;
  try {
    for (const register of registrations) {
      const cleanup = register();
      if (cleanup) cleanups.push(cleanup);
    }
  } catch (error) {
    for (const cleanup of cleanups.reverse()) cleanup();
    throw error;
  }
  return () => {
    if (!mounted) return;
    mounted = false;
    for (const cleanup of cleanups.reverse()) cleanup();
  };
}
