/**
 * Carried forward unchanged from the compatibility prototype this Worker
 * supersedes. It is the durable half of the older single-effect seam that
 * `@frockbot/plugin-computer/shared-provider` still speaks, and it keeps its
 * class name, its `COMPUTER_EFFECTS` binding, its `shared-<n>` container
 * shards, and its recorded effect outcomes: superseding a Worker must not
 * delete a durable class or the effect records it holds.
 *
 * The v1 protocol in `@frockbot/computer-host-protocol` replaces this seam;
 * repointing the provider at it is the next migration step, not this one.
 */
import {
  computerHostEffectRequestWireV1,
  computerHostEffectResponseWireV1,
  decodeComputerHostEffectRequestV1,
  decodeComputerHostEffectResponseV1,
  type ComputerHostEffectResponseV1,
} from "@frockbot/computer-core/host-protocol";
import {
  computerHostShardCountV1 as shardCount,
  legacyEffectShardV1,
} from "./router.ts";

export interface ComputerEffectJournalEnv {
  FLY_HOST: {
    getByName(name: string): { fetch(request: Request): Promise<Response> };
  };
  FLY_HOST_SHARDS: string;
}

interface StoredEffectIntent {
  fingerprint: string;
  response?: ComputerHostEffectResponseV1;
  /**
   * When an attempt on this claim ended with no terminal outcome — a dropped
   * socket, a 5xx, a timeout. Only a terminal outcome is ever stored as
   * `response`; this marks a claim whose attempt is over, so the next request
   * with the same `effectId` re-drives the container instead of being told
   * forever that an answer is still coming.
   */
  unresolvedAt?: string;
}

export { shardCount };

export class ComputerEffectJournal {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: ComputerEffectJournalEnv,
  ) {}

  async fetch(request: Request): Promise<Response> {
    let effect;
    try {
      effect = decodeComputerHostEffectRequestV1(await request.json());
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "invalid request" },
        { status: 400 },
      );
    }
    const fingerprint = JSON.stringify(computerHostEffectRequestWireV1(effect));
    const claim = await this.ctx.storage.transaction(async (storage) => {
      const stored = await storage.get<StoredEffectIntent>("effect");
      if (stored) {
        if (stored.fingerprint !== fingerprint) return "collision" as const;
        if (stored.response) return stored.response;
        // An attempt that ended with no terminal outcome releases its claim,
        // so this request drives the effect rather than inheriting a failure.
        if (stored.unresolvedAt === undefined) return "unresolved" as const;
        await storage.put("effect", {
          fingerprint,
        } satisfies StoredEffectIntent);
        return "owner" as const;
      }
      await storage.put("effect", { fingerprint } satisfies StoredEffectIntent);
      return "owner" as const;
    });
    if (claim === "collision") {
      return Response.json(
        computerHostEffectResponseWireV1({
          schemaVersion: 1,
          effectId: effect.effectId,
          status: "rejected",
          failure: "Computer effect identity was reused",
        }),
        { status: 409 },
      );
    }
    if (claim === "unresolved") {
      return Response.json(
        computerHostEffectResponseWireV1({
          schemaVersion: 1,
          effectId: effect.effectId,
          status: "unresolved",
          failure: "Computer effect outcome is not yet durable",
        }),
        { status: 202 },
      );
    }
    if (claim !== "owner") {
      return Response.json(computerHostEffectResponseWireV1(claim));
    }
    let response: ComputerHostEffectResponseV1;
    try {
      const container = this.env.FLY_HOST.getByName(
        legacyEffectShardV1(
          effect.tenant.botId,
          shardCount(this.env.FLY_HOST_SHARDS),
        ),
      );
      const result = await container.fetch(
        new Request("http://computer-host.internal/v1/effects", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: fingerprint,
          signal: request.signal,
        }),
      );
      response = decodeComputerHostEffectResponseV1(await result.json());
    } catch (error) {
      response = {
        schemaVersion: 1,
        effectId: effect.effectId,
        status: "unresolved",
        failure:
          error instanceof Error
            ? error.message
            : "Computer host outcome is unavailable",
      };
    }
    if (response.status === "unresolved") {
      // A dropped socket, a 5xx or a timeout is not this effect's answer.
      // Stored as one it became permanent and terminal-looking: the
      // transaction above handed it back with HTTP 200 on every later attempt
      // with the same `effectId`, so a one-off network blip meant the effect
      // could never be retried and never resolved. Only a terminal outcome is
      // durable; this marks the claim so the next attempt re-drives, and
      // answers 202 as the in-flight branch already does.
      await this.ctx.storage.put("effect", {
        fingerprint,
        unresolvedAt: new Date().toISOString(),
      } satisfies StoredEffectIntent);
      return Response.json(computerHostEffectResponseWireV1(response), {
        status: 202,
      });
    }
    await this.ctx.storage.put("effect", { fingerprint, response });
    return Response.json(computerHostEffectResponseWireV1(response));
  }
}
