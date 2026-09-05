import { WorkerEntrypoint } from "cloudflare:workers";
import { resolveStub } from "./registry";

/**
 * What a loopback carries about the call it is for. The loader Worker mints the
 * loopback with these; the Dynamic Worker holding it never sees them, so a
 * hosted plugin can neither read nor forge the identity its calls arrive under.
 */
export interface StubProps {
  /** Which host granted the stub. */
  readonly hostId: string;
  /** The hosted instance the call is attributed to. */
  readonly instanceId: string;
  /** Which of the instance's granted stubs this loopback is. */
  readonly stub: string;
}

/**
 * What a loopback answers with. An envelope rather than a throw, so a refused
 * or revoked call is ordinary data on the wire and becomes an exception only
 * where the plugin's own code can catch it.
 */
export interface StubAnswer {
  ok: boolean;
  value?: unknown;
  message?: string;
}

const maxLoopbackBytes = 1024 * 1024;
const payloadBytes = (value: unknown): number => {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

const tooLarge = (value: unknown): StubAnswer | undefined =>
  payloadBytes(value) > maxLoopbackBytes
    ? {
        ok: false,
        message: `stub payload exceeds the ${maxLoopbackBytes}-byte loopback limit`,
      }
    : undefined;

/** How a loopback re-enters the object that owns a host's stubs. */
export interface StubReentry {
  composeStubCall: (props: StubProps, input: unknown) => Promise<StubAnswer>;
}

const reentries = new Map<string, () => StubReentry>();

/**
 * Route every loopback call for `hostId` back into the Durable Object that
 * owns the host. A loopback runs in the loader Worker's own request; a host
 * whose handlers touch the object (its facets, its storage) must run them in
 * a request the object is handling, so the loopback asks the object — through
 * a stub minted per call — to dispatch on its behalf.
 */
export function registerStubReentry(
  hostId: string,
  reentry: () => StubReentry,
): () => void {
  reentries.set(hostId, reentry);
  return () => {
    if (reentries.get(hostId) === reentry) reentries.delete(hostId);
  };
}

/**
 * Dispatch one stub call on the client side, under the instance id the props
 * carry. Call from inside the object that owns the host (a re-entered RPC) or,
 * for a host with no object, from the loopback itself.
 */
export async function dispatchStubCall(
  props: StubProps,
  input: unknown,
): Promise<StubAnswer> {
  const stub = resolveStub(props.hostId, props.instanceId, props.stub);
  if (!stub) {
    return {
      ok: false,
      message: `@frockbot/compose-cloudflare: stub "${props.stub}" was revoked when instance "${props.instanceId}" stopped`,
    };
  }
  try {
    const value = await stub(input);
    return tooLarge(value) ?? { ok: true, value };
  } catch (error) {
    const message = (error as { message?: unknown } | null)?.message;
    return {
      ok: false,
      message: typeof message === "string" ? message : String(error),
    };
  }
}

/**
 * The one entrypoint a hosted plugin can reach: a stub, arriving as a loopback
 * binding in the Dynamic Worker's `env` (ADR-0005). Re-export it from your
 * loader Worker's entry module so `exports` can mint it:
 *
 * @example
 * ```ts
 * export { ComposeStubLoopback } from '@frockbot/compose-cloudflare'
 * ```
 */
export class ComposeStubLoopback extends WorkerEntrypoint {
  /**
   * Dispatch one stub call on the client side, under the instance id the props
   * carry rather than anything the caller supplied.
   */
  async stubCall(input: unknown): Promise<StubAnswer> {
    const refused = tooLarge(input);
    if (refused) return refused;
    const props = this.ctx.props as StubProps | undefined;
    if (!props) {
      return {
        ok: false,
        message:
          "@frockbot/compose-cloudflare: a stub loopback was called without props; mint it through the host",
      };
    }
    const reentry = reentries.get(props.hostId);
    if (reentry) return await reentry().composeStubCall(props, input);
    return await dispatchStubCall(props, input);
  }
}
