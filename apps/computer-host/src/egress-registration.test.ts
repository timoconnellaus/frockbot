/**
 * The seam between our egress configuration and the library that enforces it.
 *
 * `outbound.test.ts` proves the bridge pumps a socket correctly. It cannot
 * prove the bridge is ever *reached*, and for one release it was not: the
 * handler was declared as a static class field, and a class field defines an
 * own property rather than assigning through the inherited accessor. The base
 * class registers handlers in a module-level registry from inside a static
 * setter, so the field silently shadowed the setter, the registry stayed empty,
 * and `ContainerProxy` fell through to a plain `fetch` — which cannot complete
 * a WebSocket upgrade. Every `exec` failed at the handshake while the
 * configuration read as correct.
 *
 * These tests drive the library's own resolution chain rather than a model of
 * it, so the registration is checked the way the proxy checks it.
 */
import { beforeAll, describe, expect, mock, test } from "bun:test";

// The library and the Worker both import `cloudflare:workers`, which exists
// only inside workerd. Only two base classes are needed for the parts of the
// chain under test, and neither is called: nothing here constructs a
// Durable Object.
mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
  WorkerEntrypoint: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
}));

/** The props `Container` hands `ContainerProxy`, as this Worker configures it. */
interface ProxyProps {
  className: string;
  containerId: string;
  enableInternet: boolean;
  allowedHosts?: string[];
  deniedHosts?: string[];
  interceptAll: boolean;
  outboundByHostOverrides?: Record<string, unknown>;
  outboundHandlerOverride?: unknown;
}

// The library types `outboundByHost` as an accessor and `ContainerProxy`'s
// props as internal, so the seam under test is deliberately untyped here.
let Container: any;
let ContainerProxy: any;
let FlyHostContainer: any;
let SPRITES_API_HOST: string;
let COMPUTER_HOST_EGRESS_V1: {
  enableInternet: boolean;
  allowedHosts: readonly string[];
  interceptHttps: boolean;
};

beforeAll(async () => {
  const containers = await import("@cloudflare/containers");
  Container = containers.Container;
  ContainerProxy = containers.ContainerProxy;
  const egress = await import("./egress.ts");
  SPRITES_API_HOST = egress.SPRITES_API_HOST;
  COMPUTER_HOST_EGRESS_V1 = egress.COMPUTER_HOST_EGRESS_V1;
  // The production module, not a replica: the declaration style is the thing
  // under test, so a copy of it here would prove nothing.
  FlyHostContainer = (await import("./index.ts")).FlyHostContainer;
});

describe("the Sprites outbound handler is registered", () => {
  test("is not declared as a static class field", () => {
    // A field would define an own property and shadow the base setter, which
    // is exactly how the registration was lost.
    expect(
      Object.getOwnPropertyDescriptor(FlyHostContainer, "outboundByHost"),
    ).toBeUndefined();
  });

  test("resolves through the registry the proxy reads", () => {
    // `ContainerProxy` looks the handlers up by class name. Reading them off
    // the class goes through the base getter, which is that same lookup.
    const handlers = Reflect.get(
      Container,
      "outboundByHost",
      FlyHostContainer,
    ) as Record<string, unknown> | undefined;
    expect(handlers).toBeDefined();
    expect(Object.keys(handlers ?? {})).toEqual([SPRITES_API_HOST]);
  });

  test("is registered under the class name the proxy is given", () => {
    // The proxy receives `this.constructor.name`; the registry is keyed by the
    // same string. Renaming the class would break the lookup silently.
    expect(FlyHostContainer.name).toBe("FlyHostContainer");
  });
});

describe("the proxy dispatches Sprites traffic to that handler", () => {
  /** Production's props, as `applyOutboundInterception` assembles them. */
  const props = (): ProxyProps => ({
    className: FlyHostContainer.name,
    containerId: "test-container",
    enableInternet: COMPUTER_HOST_EGRESS_V1.enableInternet,
    allowedHosts: [...COMPUTER_HOST_EGRESS_V1.allowedHosts],
    // An allowlist promotes the container to intercept-all, so this mirrors
    // what `shouldInterceptAllOutbound` returns for this configuration.
    interceptAll: true,
  });

  /**
   * Drives the real proxy, with the registered handler wrapped so the call can
   * be observed. The wrapper delegates to whatever production registered, so
   * the chain being exercised is the real one; the tests above pin down what
   * that registration contains.
   */
  async function dispatch(url: string): Promise<{
    handled: boolean;
    fetches: number;
    fetchedInsideHandler: boolean;
    response: Response;
  }> {
    const registered = Reflect.get(
      Container,
      "outboundByHost",
      FlyHostContainer,
    ) as Record<string, (request: Request) => Promise<Response>> | undefined;

    let handled = false;
    const wrapped: Record<string, unknown> = {};
    for (const [host, handler] of Object.entries(registered ?? {})) {
      wrapped[host] = (request: Request) => {
        handled = true;
        return handler(request);
      };
    }
    Reflect.set(Container, "outboundByHost", wrapped, FlyHostContainer);

    // Both paths end in a `fetch` to the origin, so the call alone does not
    // tell them apart — but the order does. The handler fetches *after* it has
    // been entered; step 7's fallback fetches without it ever being entered.
    let fetches = 0;
    let fetchedInsideHandler = false;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetches += 1;
      fetchedInsideHandler = handled;
      return new Response("origin", { headers: { "x-path": "origin" } });
    }) as unknown as typeof fetch;

    try {
      const proxy = new ContainerProxy({ props: props() }, {});
      const response = await proxy.fetch(
        new Request(url, {
          headers: { upgrade: "websocket", connection: "Upgrade" },
        }),
      );
      return { handled, fetches, fetchedInsideHandler, response };
    } finally {
      globalThis.fetch = realFetch;
      Reflect.set(Container, "outboundByHost", registered, FlyHostContainer);
    }
  }

  test("an exec upgrade reaches the handler, not the bare-fetch fallback", async () => {
    const { handled, fetches, fetchedInsideHandler } = await dispatch(
      `https://${SPRITES_API_HOST}/v1/sprites/frockbot-test/exec?cmd=bash`,
    );
    expect(handled).toBe(true);
    // Reaching the origin from inside the handler is the bridge doing its job.
    // Reaching it without the handler is step 7 — the path that shipped
    // `Invalid Upgrade header`.
    expect(fetches).toBe(1);
    expect(fetchedInsideHandler).toBe(true);
  });

  test("the allowlist still refuses every other host", async () => {
    const { handled, fetches, response } = await dispatch(
      "https://example.com/v1/anything",
    );
    expect(handled).toBe(false);
    expect(fetches).toBe(0);
    expect(response.status).toBe(520);
  });
});
