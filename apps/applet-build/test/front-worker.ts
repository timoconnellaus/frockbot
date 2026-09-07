/**
 * The Worker under test: the production router, with a fake container.
 *
 * The container is the one thing a runtime test cannot have — it is a Docker
 * image and a Node process — so it is replaced at the seam the router already
 * has, its stub resolver, and everything above it is the real thing. What the
 * fake returns is a transcript of what reached it, so the test can assert on
 * the forward rather than on the router's intentions.
 */
import { APPLET_BUILD_TOKEN_HEADER } from "@frockbot/applets/build-contract";
import { routeAppletBuildRequestV1 } from "../src/router.ts";

export const FRONT_WORKER_TOKEN = "workerd-shared-token";

export default {
  fetch(request: Request): Promise<Response> {
    return routeAppletBuildRequestV1(
      request,
      { hostToken: FRONT_WORKER_TOKEN, shards: 2 },
      (shard) => ({
        fetch: async (forwarded) =>
          Response.json({
            shard,
            method: forwarded.method,
            path: new URL(forwarded.url).pathname,
            token: forwarded.headers.get(APPLET_BUILD_TOKEN_HEADER),
            contentType: forwarded.headers.get("content-type"),
            body: await forwarded.text(),
          }),
      }),
    );
  },
};
