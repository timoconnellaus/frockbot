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
import type { SeededPluginV1 } from "@frockbot/app/plugins/catalog";
import {
  readUserCompositionV1,
  userCompositionFailuresV1,
  userCompositionStoreV1,
  type UserCompositionRpcV1,
} from "./user.js";

/**
 * The catalog defaults to empty rather than to the deployment's: an in-memory
 * harness has no Worker Loader, and a seeded Plugin nothing can mount would
 * fail every Turn it reconciles into rather than failing alone. A test about
 * seeding passes its own.
 */
export function memoryUserCompositionV1(
  storage: MemoryStorage = new MemoryStorage(),
  catalog: readonly SeededPluginV1[] = [],
): UserCompositionRpcV1 & { storage: MemoryStorage } {
  const state = { ctx: { storage } as unknown as DurableObjectState };
  const store = () => userCompositionStoreV1(state);
  const failures = () => userCompositionFailuresV1(state);
  return {
    storage,
    // Reconciled with no admin-opened Plugins, the way a fresh account reads.
    readComposition: (request) =>
      readUserCompositionV1(state, {
        userId: request.userId,
        catalog,
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
