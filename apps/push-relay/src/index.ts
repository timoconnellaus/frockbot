import { DurableObject } from "cloudflare:workers";
import {
  RetryablePushError,
  sendFcmMessageV1,
  type PushPlatformV1,
} from "@frockbot/core/push";
import {
  consumeV1,
  handleObjectV1,
  handleRelayRequestV1,
  type RateLimitV1,
  type RelayObjectsV1,
  type RelayRegistrationV1,
  type RelayStorageV1,
} from "./relay.ts";

interface Env {
  RELAY: DurableObjectNamespace<RelayObject>;
  /** The released apps' Firebase service account. Held here and nowhere else. */
  FCM_SERVICE_ACCOUNT?: string;
}

/**
 * One handle, or one rate-limit key: a few small records each, so one class
 * serves both, named `handle:<handle>` or `limit:<key>`.
 */
export class RelayObject extends DurableObject<Env> {
  private get records(): RelayStorageV1 {
    const storage = this.ctx.storage;
    return {
      get: (key) => storage.get(key),
      put: (key, value) => storage.put(key, value),
      deleteAll: () => storage.deleteAll(),
      setAlarm: (at) => storage.setAlarm(at),
    };
  }

  register(registration: Omit<RelayRegistrationV1, "touchedAt">) {
    return handleObjectV1.register(this.records, registration, Date.now());
  }

  rotate(update: { token: string; platform: PushPlatformV1 }) {
    return handleObjectV1.rotate(this.records, update, Date.now());
  }

  unregister() {
    return handleObjectV1.unregister(this.records);
  }

  authorizeSend() {
    return handleObjectV1.authorizeSend(this.records, Date.now());
  }

  /** A limiter holds no registration, so its alarm forgets it once idle. */
  async consume(limit: RateLimitV1) {
    const now = Date.now();
    const used = await consumeV1(this.records, "limit", limit, now);
    await this.ctx.storage.setAlarm(now + limit.windowMs);
    return used;
  }

  override async alarm() {
    await handleObjectV1.alarm(this.records, Date.now());
  }
}

export default {
  fetch(request, env) {
    const named = (name: string) => env.RELAY.get(env.RELAY.idFromName(name));
    const objects: RelayObjectsV1 = {
      handle: (handle) => named(`handle:${handle}`),
      limiter: (key) => named(`limit:${key}`),
    };
    return handleRelayRequestV1(request, objects, async (message) => {
      // Nothing was sent, so the server may try again once it is set.
      if (!env.FCM_SERVICE_ACCOUNT)
        throw new RetryablePushError("The relay has no FCM credentials");
      return sendFcmMessageV1(env.FCM_SERVICE_ACCOUNT, message);
    });
  },
} satisfies ExportedHandler<Env>;
