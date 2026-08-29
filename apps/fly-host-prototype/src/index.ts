import { Container, ContainerProxy } from "@cloudflare/containers";
import { routeFlyHostRequest } from "./router.ts";

interface FlyHostEnv {
  FLY_HOST: DurableObjectNamespace<FlyHostContainer>;
  FLY_HOST_SHARDS: string;
  PROTOTYPE_CREDENTIAL_REF: string;
  SPRITES_TOKEN: string;
}

export class FlyHostContainer extends Container<FlyHostEnv> {
  defaultPort = 8080;
  requiredPorts = [8080];
  sleepAfter = "2m";
  enableInternet = true;
  interceptHttps = true;

  static outboundByHost = {
    "credential-broker.invalid": () =>
      new Response("prototype broker is not configured", { status: 503 }),
  };

  constructor(ctx: DurableObjectState<{}>, env: FlyHostEnv) {
    super(ctx, env);
    this.envVars = {
      NODE_EXTRA_CA_CERTS: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
      SPRITES_TOKEN: env.SPRITES_TOKEN,
    };
  }
}

export { ContainerProxy };

function shardCount(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

export default {
  fetch(request: Request, env: FlyHostEnv): Promise<Response> {
    return routeFlyHostRequest(
      request,
      {
        credentialRef: env.PROTOTYPE_CREDENTIAL_REF,
        shards: shardCount(env.FLY_HOST_SHARDS),
      },
      (shard) => env.FLY_HOST.getByName(shard),
    );
  },
} satisfies ExportedHandler<FlyHostEnv>;
