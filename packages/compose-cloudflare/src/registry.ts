/**
 * How a loopback entrypoint finds the client that granted a stub.
 *
 * A loopback runs in the loader Worker, in its own I/O context, with nothing
 * but `ctx.props` to go on. The props name a host and a hosted instance; this
 * module-level table turns that pair back into the client-side callables the
 * kernel bound before the host was ever asked to start anything.
 *
 * The table is module state in the loader Worker's isolate — the same isolate
 * the client and the kernel run in — so an entry is reachable exactly while the
 * instance that owns it is running, and revocation is a delete.
 */

/** The client-side callables one hosted instance was granted. */
type Grants = Readonly<Record<string, (input: unknown) => Promise<unknown>>>;

const hosts = new Map<string, Map<string, Grants>>();

/**
 * Record one hosted instance's stubs. Returns the revoke: after it runs, every
 * loopback call for that instance fails rather than landing.
 */
export function grantStubs(
  hostId: string,
  instanceId: string,
  stubs: Grants,
): () => void {
  let instances = hosts.get(hostId);
  if (!instances) {
    instances = new Map();
    hosts.set(hostId, instances);
  }
  instances.set(instanceId, stubs);
  return () => {
    const current = hosts.get(hostId);
    if (!current) return;
    if (current.get(instanceId) === stubs) current.delete(instanceId);
    if (current.size === 0) hosts.delete(hostId);
  };
}

/** The callable for one granted stub, or `undefined` once it is revoked. */
export function resolveStub(
  hostId: string,
  instanceId: string,
  stub: string,
): ((input: unknown) => Promise<unknown>) | undefined {
  return hosts.get(hostId)?.get(instanceId)?.[stub];
}
