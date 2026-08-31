import { Container, ContainerProxy } from "@cloudflare/containers";
import { decodeComputerHostEffectRequestV1 } from "@frockbot/computer-core/host-protocol";
import {
  ComputerEffectJournal,
  shardCount,
  type ComputerEffectJournalEnv,
} from "./effect-journal.ts";
import { routeFlyHostRequest } from "./router.ts";

interface FlyHostEnv extends ComputerEffectJournalEnv {
  FLY_HOST: DurableObjectNamespace<FlyHostContainer>;
  COMPUTER_EFFECTS: DurableObjectNamespace;
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
      new Response("credential broker is not configured", { status: 503 }),
  };

  constructor(ctx: DurableObjectState<{}>, env: FlyHostEnv) {
    super(ctx, env);
    this.envVars = {
      NODE_EXTRA_CA_CERTS: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
      SPRITES_TOKEN: env.SPRITES_TOKEN,
    };
  }
}

export { ComputerEffectJournal, ContainerProxy };

function requestUrl(request: Request): URL {
  try {
    return new URL(request.url);
  } catch {
    throw new Error("Computer host request URL is invalid");
  }
}

export default {
  async fetch(request: Request, env: FlyHostEnv): Promise<Response> {
    const url = requestUrl(request);
    if (url.pathname === "/v1/effects" && request.method === "POST") {
      let effect;
      try {
        effect = decodeComputerHostEffectRequestV1(
          await request.clone().json(),
        );
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "invalid request" },
          { status: 400 },
        );
      }
      const journal = env.COMPUTER_EFFECTS.getByName(
        JSON.stringify([
          effect.identity.userId,
          effect.tenant.botId,
          effect.effectId,
        ]),
      );
      return journal.fetch(request);
    }
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
