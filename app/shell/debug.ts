// The operator's read of one Bot Durable Object. See `debug-protocol.ts` for
// why this is not the client's transcript projection.

import type { BotSettingsViewV1 } from "@frockbot/core/configuration";
import type { BotIdentity } from "@frockbot/core/durable";
import type { ShellBotStateV1 } from "./backend-state.js";
import {
  compositionFailureLogV1,
  listUserCompositionGenerationsV1,
  readUserCompositionSnapshotV1,
} from "@frockbot/app/composition/bot";
import {
  BOT_DEBUG_DEFAULT_RUN_LIMIT_V1,
  BOT_DEBUG_EVENT_BYTES_V1,
  BOT_DEBUG_GENERATION_LIMIT_V1,
  boundDebugEventsV1,
  decodeBotDebugQueryV1,
  type BotDebugRunV1,
  type BotDebugSnapshotV1,
} from "./debug-protocol.js";

/**
 * The operator's snapshot: durable runs unprojected, the Composition
 * generations they pinned, and the failures recorded against those
 * generations. See `debug-protocol.ts` for why this is not `listRuns`.
 *
 * Read-only on purpose — no `recoverActiveRun`, no reconciliation. Looking
 * at a wedged Bot must not be what unwedges it, or the next look tells you
 * nothing about what it was doing.
 */
export async function debugSnapshot(
  state: ShellBotStateV1,
  identity: BotIdentity,
  readSettings: () => Promise<BotSettingsViewV1>,
  input: unknown = { schemaVersion: 1 },
): Promise<BotDebugSnapshotV1> {
  const query = decodeBotDebugQueryV1(input);
  // The Composition is the User's; the Bot holds only the pin it mirrored.
  // Read from the User, and read only: looking at a wedged Bot must not be
  // what re-points its mirror.
  const failures = compositionFailureLogV1(state, identity);
  const [activeRunId, composition, notifications] = await Promise.all([
    state.authority.readActiveRunId(),
    readUserCompositionSnapshotV1(state, identity),
    state.authority.listNotifications(),
  ]);
  const current = composition.current;
  // A Bot whose first generation never mounted falls back to its bootstrap;
  // the pair is read together, so there is nothing here that can be absent.
  const lastKnownGoodGenerationId = composition.lastKnownGood.generationId;
  const generationPage = await listUserCompositionGenerationsV1(
    state,
    identity,
    { limit: BOT_DEBUG_GENERATION_LIMIT_V1 },
  );
  const generations = await Promise.all(
    generationPage.generations.map(async (generation) => ({
      generationId: generation.generationId,
      createdAt: generation.createdAt,
      status: generation.status,
      origin: generation.origin.kind,
      artifactSetHash: generation.artifactSetHash,
      ...(generation.parentGenerationId === undefined
        ? {}
        : { parentGenerationId: generation.parentGenerationId }),
      memberCount: generation.members.length,
      failures: await failures.list(generation.generationId),
      quarantined:
        (await failures.quarantine(generation.generationId)) !== undefined,
    })),
  );

  let candidates: Array<{ cursor?: string; runId: string }>;
  let nextCursor: string | undefined;
  if (query.runId) {
    candidates = [{ runId: query.runId }];
  } else {
    const limit = query.limit ?? BOT_DEBUG_DEFAULT_RUN_LIMIT_V1;
    const page = await state.authority.listRunIndex({
      limit: limit + 1,
      ...(query.before ? { before: query.before } : {}),
    });
    candidates = page.slice(0, limit);
    // The active run is not necessarily the newest admitted one; a wedged
    // run older than the page would otherwise be invisible here.
    if (
      activeRunId &&
      !query.before &&
      !candidates.some((candidate) => candidate.runId === activeRunId)
    ) {
      candidates.unshift({ runId: activeRunId });
    }
    if (page.length > limit) nextCursor = candidates.at(-1)?.cursor;
  }
  const includeEvents = query.runId !== undefined || query.events === true;
  let budget = BOT_DEBUG_EVENT_BYTES_V1;
  const runs: BotDebugRunV1[] = [];
  for (const candidate of candidates) {
    const projected = await state.authority.readRunEventProjections(
      candidate.runId,
    );
    if (!projected) continue;
    const { run: stored } = projected;
    const bounded = includeEvents
      ? boundDebugEventsV1(projected.events, budget)
      : undefined;
    if (bounded) budget = Math.max(0, budget - bounded.spent);
    runs.push({
      runId: stored.runId,
      sessionId: stored.sessionId,
      acceptedAt: stored.acceptedAt,
      status: stored.status,
      phase: stored.phase,
      input: stored.input,
      commandFingerprint: stored.commandFingerprint,
      compositionGenerationId: stored.compositionGenerationId,
      previousEventCount: stored.previousEventCount,
      eventCount: projected.eventCount,
      ...(stored.responseText === undefined
        ? {}
        : { responseText: stored.responseText }),
      ...(stored.failure === undefined ? {} : { failure: stored.failure }),
      ...(bounded
        ? {
            events: bounded.events,
            ...(bounded.omittedEvents > 0
              ? { omittedEvents: bounded.omittedEvents }
              : {}),
          }
        : {}),
    });
  }

  let configuration: BotSettingsViewV1 | undefined;
  try {
    configuration = await readSettings();
  } catch {
    // Settings that will not resolve are a live cause of a Bot that never
    // runs a turn, so the snapshot reports the rest rather than failing.
    configuration = undefined;
  }
  return {
    schemaVersion: 1,
    botId: identity.botId,
    capturedAt: new Date().toISOString(),
    ...(activeRunId ? { activeRunId } : {}),
    composition: {
      currentGenerationId: current.generationId,
      currentStatus: current.status,
      ...(lastKnownGoodGenerationId ? { lastKnownGoodGenerationId } : {}),
      generations,
    },
    ...(configuration ? { configuration } : {}),
    notifications,
    runs,
    ...(nextCursor ? { nextCursor } : {}),
  };
}
