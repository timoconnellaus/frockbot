/**
 * The shared Computer host Worker.
 *
 * It supersedes the compatibility prototype that first held this script name.
 * The prototype proved the boundary with a single `/v1/computer/smoke` DTO;
 * this Worker serves the real v1 protocol and routes it to a bounded pool of
 * containers, one of which holds each User's Computer.
 */

import { Container, ContainerProxy } from "@cloudflare/containers";
import { COMPUTER_HOST_EGRESS_V1, SPRITES_API_HOST } from "./egress.ts";
import { createOutboundWebSocketProxyV1 } from "./outbound.ts";
import {
  computerHostShardCountV1,
  routeComputerHostRequestV1,
} from "./router.ts";

export interface ComputerHostEnv {
  COMPUTER_HOST_CONTAINER: DurableObjectNamespace<FlyHostContainer>;
  COMPUTER_HOST_SHARDS: string;
  /** Fly Sprites account token. Reaches the container's env and nothing else. */
  SPRITES_TOKEN: string;
  /** Shared secret between the app Worker, this Worker, and the container. */
  COMPUTER_HOST_TOKEN: string;
  FROCKBOT_SPRITE_NAME?: string;
  /** Fly region for newly created Sprites; unset lets the platform choose. */
  FROCKBOT_SPRITE_REGION?: string;
}

/**
 * One shard of the shared Computer host.
 *
 * The container holds no canonical Bot state, so a shard is a placement
 * decision and nothing more: it may sleep, restart, or migrate, and the next
 * request re-derives everything it needs from the Sprite. `sleepAfter` is
 * therefore a cost knob rather than a correctness one — a cold start costs one
 * caller a few seconds, never a lost effect.
 *
 * The class keeps the prototype's `FlyHostContainer` name on purpose. A
 * Cloudflare container application is bound to one Durable Object class for
 * its lifetime, and the deployed application
 * (`frockbot-computer-host-flyhostcontainer`) is already bound to this name.
 * Renaming the class asks Cloudflare to create a second application for the
 * same script and the deploy fails with `DURABLE_OBJECT_ALREADY_HAS_APPLICATION`;
 * the only way to take a new name is to delete the container application
 * first, which would drop the running containers. The legacy name is the
 * cheap half of that trade, so it stays.
 */
export class FlyHostContainer extends Container<ComputerHostEnv> {
  defaultPort = 8080;
  requiredPorts = [8080];
  sleepAfter = "30m";
  enableInternet = COMPUTER_HOST_EGRESS_V1.enableInternet;
  allowedHosts = [...COMPUTER_HOST_EGRESS_V1.allowedHosts];
  /**
   * The interception proxy's own fallback is a plain `fetch`, which cannot
   * complete a proxied WebSocket upgrade — and `exec` is a WebSocket, so
   * without this every shell command fails at the handshake. Runs after the
   * allowlist gate, so it widens nothing: it only carries the one host the
   * allowlist already admits.
   *
   * Assigned in a static block rather than declared as a static field, and the
   * difference is load-bearing. `outboundByHost` is a static *accessor* on
   * `Container`, and its setter is what records the handler in the registry
   * `ContainerProxy` later reads. A class field would define an own property
   * instead of assigning through that setter: the registry would stay empty,
   * the proxy would fall through to its plain `fetch`, and the configuration
   * would still read as correct. `egress-registration.test.ts` holds this.
   */
  static {
    this.outboundByHost = {
      [SPRITES_API_HOST]: (request: Request) =>
        createOutboundWebSocketProxyV1()(request),
    };
  }
  /**
   * Requires the container to trust the CA the platform mints for the
   * interception; `container/entrypoint.sh` does that at start, because the
   * certificate is ephemeral and cannot be baked into the image.
   */
  interceptHttps = COMPUTER_HOST_EGRESS_V1.interceptHttps;

  constructor(ctx: DurableObjectState<{}>, env: ComputerHostEnv) {
    super(ctx, env);
    // The Sprites token is injected here and nowhere else. It never enters the
    // Bot Durable Object, the Bot isolate, or the Workspace: the caller sends
    // only `credentialRef`, which the container resolves.
    this.envVars = {
      SPRITES_TOKEN: env.SPRITES_TOKEN,
      COMPUTER_HOST_TOKEN: env.COMPUTER_HOST_TOKEN,
      ...(env.FROCKBOT_SPRITE_NAME
        ? { FROCKBOT_SPRITE_NAME: env.FROCKBOT_SPRITE_NAME }
        : {}),
      ...(env.FROCKBOT_SPRITE_REGION
        ? { FROCKBOT_SPRITE_REGION: env.FROCKBOT_SPRITE_REGION }
        : {}),
    };
  }
}

export { ContainerProxy };

export default {
  async fetch(request: Request, env: ComputerHostEnv): Promise<Response> {
    let pathname: string;
    try {
      pathname = new URL(request.url).pathname;
    } catch {
      return Response.json({ error: "invalid-url" }, { status: 400 });
    }

    return routeComputerHostRequestV1(
      request,
      {
        hostToken: env.COMPUTER_HOST_TOKEN,
        shards: computerHostShardCountV1(env.COMPUTER_HOST_SHARDS),
      },
      (shard) => env.COMPUTER_HOST_CONTAINER.getByName(shard),
    );
  },
} satisfies ExportedHandler<ComputerHostEnv>;
