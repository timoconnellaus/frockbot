/**
 * The Worker under test: the production bridge and nothing else.
 *
 * `ContainerProxy` hands the handler a request and returns what it returns, so
 * standing the handler up on its own reproduces that seam exactly — without a
 * container, and without needing the platform to intercept anything.
 */
import { createOutboundWebSocketProxyV1 } from "../src/outbound.ts";

const proxy = createOutboundWebSocketProxyV1();

export default {
  fetch(request: Request): Promise<Response> {
    return proxy(request);
  },
};
