/**
 * The Plugin build service Worker.
 *
 * It holds no storage and no credential: source arrives inline, artifacts
 * leave inline, and the app Worker is the only thing that writes R2 and the
 * only thing that hash-verifies what came back. A compromised builder can
 * therefore return bytes and nothing else.
 *
 * The build itself is native binaries and a workerd — the type checker,
 * esbuild and Miniflare — which is why it is a Cloudflare Container rather
 * than a Worker: every wasm substitute would be a second derivation of the
 * module that could disagree with the one `runPluginBuildV1` produces.
 */

import { Container, ContainerProxy } from "@cloudflare/containers";
import {
  pluginBuildShardCountV1,
  routePluginBuildRequestV1,
} from "./router.ts";

export interface AppletBuildEnv {
  APPLET_BUILD_CONTAINER: DurableObjectNamespace<AppletBuildContainer>;
  APPLET_BUILD_SHARDS: string;
  /** Shared secret between the app Worker, this Worker, and the container. */
  APPLET_BUILD_TOKEN: string;
}

/**
 * One shard of the build service.
 *
 * The container holds nothing durable, so a shard is a placement decision: it
 * may sleep, restart or migrate, and the next request rebuilds from the source
 * it is handed. `sleepAfter` is a cost knob rather than a correctness one — a
 * cold start costs one caller a few seconds of a build that already takes
 * some.
 *
 * No egress. Every dependency the pipeline needs is in the image, and a
 * Plugin's source is never executed anywhere it could reach the network: the
 * `describe` stage boots it inside Miniflare with every fetch refused.
 */
export class AppletBuildContainer extends Container<AppletBuildEnv> {
  defaultPort = 8080;
  requiredPorts = [8080];
  sleepAfter = "10m";
  enableInternet = false;

  constructor(ctx: DurableObjectState<{}>, env: AppletBuildEnv) {
    super(ctx, env);
    this.envVars = { APPLET_BUILD_TOKEN: env.APPLET_BUILD_TOKEN };
  }
}

export { ContainerProxy };

export default {
  fetch(request: Request, env: AppletBuildEnv): Promise<Response> {
    return routePluginBuildRequestV1(
      request,
      {
        hostToken: env.APPLET_BUILD_TOKEN,
        shards: pluginBuildShardCountV1(env.APPLET_BUILD_SHARDS),
      },
      (shard) => env.APPLET_BUILD_CONTAINER.getByName(shard),
    );
  },
} satisfies ExportedHandler<AppletBuildEnv>;
