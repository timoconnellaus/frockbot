/**
 * Visible conversation contributions: the Shell's projection of a committed
 * send, run status, announcement or card revision onto the publication store.
 */
import { type SessionEvent } from "@frockbot/core/contracts";
import {
  announcementEntityIdV1,
  cardEntityIdV1,
  messageEntityIdV1,
  runEntityIdV1,
  type PublicationContributionV1,
  type StoredRunV1,
} from "@frockbot/core/durable";
import {
  isVisibleRunV1,
  projectClientAnnouncementsV1,
  projectClientRunV1,
  type ClientRunV1,
} from "./run-protocol.js";
import type { BotSettingsViewV1 } from "@frockbot/core/configuration";

export type VisiblePublicationCauseV1 = "admission" | "events" | "terminal";

function sendOrdinal(
  events: readonly SessionEvent[],
  occurrenceId: string,
): number {
  let ordinal = 0;
  for (const event of events) {
    if (event.type !== "send/to-user") continue;
    if (event.occurrenceId === occurrenceId) return ordinal;
    ordinal += 1;
  }
  return ordinal;
}

function cardSurfaceId(payload: unknown): string | undefined {
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    (payload as { type?: unknown }).type !== "card"
  ) {
    return undefined;
  }
  const surfaceId = (payload as { surfaceId?: unknown }).surfaceId;
  return typeof surfaceId === "string" && surfaceId.length > 0
    ? surfaceId
    : undefined;
}

function runStatusContribution(
  run: StoredRunV1<BotSettingsViewV1>,
): PublicationContributionV1 | undefined {
  if (!isVisibleRunV1(run)) return undefined;
  const projected: ClientRunV1 = projectClientRunV1(run);
  return {
    kind: "run-status",
    entityId: runEntityIdV1(run.runId),
    payload: { run: projected },
  };
}

export function visiblePublicationsV1(input: {
  cause: VisiblePublicationCauseV1;
  run: StoredRunV1<BotSettingsViewV1>;
  events?: readonly SessionEvent[];
}): PublicationContributionV1[] {
  const contributions: PublicationContributionV1[] = [];
  // What a group Turn sends is the group's, read back by its own object.
  if (input.run.admission?.origin?.kind === "group") return contributions;
  if (input.cause === "admission" || input.cause === "terminal") {
    const status = runStatusContribution(input.run);
    if (status) contributions.push(status);
  }
  if (input.cause !== "events") return contributions;
  const batch = input.events ?? [];
  for (const event of batch) {
    if (event.type === "send/to-user") {
      contributions.push({
        kind: "message",
        entityId: messageEntityIdV1({
          sessionId: input.run.sessionId,
          runId: input.run.runId,
          occurrenceId: event.occurrenceId,
        }),
        payload: {
          runId: input.run.runId,
          sessionId: input.run.sessionId,
          occurrenceId: event.occurrenceId,
          event: {
            type: "send/to-user",
            payload: event.payload,
            ordinal: sendOrdinal(input.run.events, event.occurrenceId),
          },
        },
      });
      const surfaceId = cardSurfaceId(event.payload);
      if (surfaceId) {
        contributions.push({
          kind: "card-revision",
          entityId: cardEntityIdV1(surfaceId),
          payload: { surfaceId, revision: 0 },
        });
      }
      continue;
    }
    const announcement = announcementPublicationV1(event);
    if (announcement) contributions.push(announcement);
  }
  return contributions;
}

export function announcementPublicationV1(
  event: SessionEvent,
): PublicationContributionV1 | undefined {
  const projected = projectClientAnnouncementsV1([event])[0];
  if (!projected) return undefined;
  return {
    kind: "announcement",
    entityId: announcementEntityIdV1(projected.announcementId),
    payload: { announcement: projected },
  };
}

export function cardRevisionPublicationV1(input: {
  surfaceId: string;
  revision: number;
}): PublicationContributionV1 {
  return {
    kind: "card-revision",
    entityId: cardEntityIdV1(input.surfaceId),
    revision: Math.max(1, input.revision),
    payload: { surfaceId: input.surfaceId, revision: input.revision },
  };
}
