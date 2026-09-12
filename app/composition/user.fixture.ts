// A whole User Composition in memory, served through the same RPC surface the
// User Durable Object serves (ADR 0026). A Bot's unit-test harness gives its
// `USER_CONFIGURATIONS` stub these methods, so the Bot half under test talks
// to the real store — propose, commit, fail, quarantine — rather than to a
// second authority that only exists in tests.
import {
  decodeCompositionGenerationV1,
  type CompositionOriginV1,
} from "@frockbot/core/durable";
import { MemoryStorage } from "@frockbot/core/durable/testing";
import { DEPLOYMENT_PLUGIN_CATALOG_V1 } from "@frockbot/app/plugins/catalog";
import {
  readUserCompositionV1,
  userCompositionFailuresV1,
  userCompositionStoreV1,
  type UserCompositionRpcV1,
} from "./user.js";

export function memoryUserCompositionV1(
  storage: MemoryStorage = new MemoryStorage(),
): UserCompositionRpcV1 & { storage: MemoryStorage } {
  const state = { ctx: { storage } as unknown as DurableObjectState };
  const store = () => userCompositionStoreV1(state);
  const failures = () => userCompositionFailuresV1(state);
  return {
    storage,
    // The unit harness reconciles against the deployment catalog with no
    // admin-opened Plugins, the way a fresh account reads.
    readComposition: (request) =>
      readUserCompositionV1(state, {
        userId: request.userId,
        catalog: DEPLOYMENT_PLUGIN_CATALOG_V1,
        adminOpened: [],
      }),
    readCompositionGeneration: (request) => store().read(request.generationId),
    proposeComposition: (request) =>
      store().propose(decodeCompositionGenerationV1(request.generation), {
        ...(request.pin === undefined ? {} : { pin: request.pin }),
        ...(request.expectedCurrentGenerationId === undefined
          ? {}
          : {
              expectedCurrentGenerationId: request.expectedCurrentGenerationId,
            }),
      }),
    commitComposition: (request) => store().commit(request.generationId),
    failComposition: (request) =>
      store().fail(request.generationId, { quarantined: request.quarantined }),
    revertComposition: (request) =>
      store().revert(
        request.toGenerationId,
        request.origin as Extract<CompositionOriginV1, { kind: "revert" }>,
      ),
    listCompositionGenerations: (request) =>
      store().list({
        limit: request.limit,
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      }),
    recordCompositionFailure: (request) => failures().record(request.failure),
    listCompositionFailures: (request) => failures().list(request.generationId),
    readCompositionQuarantine: (request) =>
      failures().quarantine(request.generationId),
    clearCompositionFailures: (request) =>
      failures().clear(request.generationId),
  };
}
