// What a Turn's spending is charged to.
//
// A Turn records the origin it was admitted with; the cause is the start of
// the chain behind that origin. Within one Bot the chain is followed through
// the runs that asked — a hand-off's parent, the firing a delivery Turn
// carries. Across objects the asking side writes the cause onto the origin,
// because the run that asked is not readable from the Bot or subagent that
// answers.
import type {
  StoredRunAdmissionV1,
  StoredRunCauseV1,
  StoredRunOriginV1,
} from "@frockbot/core/durable";

export interface RunCauseReadersV1 {
  /** A run of this Bot, header only. */
  readRun(
    runId: string,
  ): Promise<{ admission?: StoredRunAdmissionV1 } | undefined>;
}

// A hand-off may not hand off again, and a delivery Turn is opened only for a
// firing, so a real chain is two links. The bound only stops a bad record
// from looping.
const MAX_LINKS = 4;

export async function runCauseV1(
  botId: string,
  origin: StoredRunOriginV1 | undefined,
  readers: RunCauseReadersV1,
  links = 0,
): Promise<StoredRunCauseV1> {
  const chat: StoredRunCauseV1 = { kind: "chat", botId };
  if (!origin || links >= MAX_LINKS) return chat;
  switch (origin.kind) {
    // No name: the cause travels inside another Bot's command, whose
    // identity must not change because the Routine was renamed before a
    // retry. The ledger learns the name from the firing's own charges.
    case "routine":
      return {
        kind: "routine",
        botId,
        id: origin.routineId,
        trigger: origin.trigger,
      };
    case "group":
      return {
        kind: "group",
        botId,
        id: origin.groupId,
        label: origin.groupName,
      };
    case "voice":
      return { kind: "voice", botId };
    case "bot":
      return origin.cause ?? { kind: "chat", botId: origin.fromBotId };
    case "subagent":
      return origin.cause ?? chat;
    case "handoff":
    case "routine-delivery": {
      const parent = await readers.readRun(
        origin.kind === "handoff" ? origin.parentRunId : origin.wakeRunId,
      );
      return runCauseV1(botId, parent?.admission?.origin, readers, links + 1);
    }
    // Mail arrives without the person opening the app, so it is its own
    // cause rather than the conversation it lands in.
    case "email":
      return { kind: "email", botId };
    // A person's answer to a card or an approval is the conversation.
    case "input-delivery":
      return chat;
  }
}

/** A cause of this Bot's own Routine, with the Routine's current name. */
export async function namedRunCauseV1(
  botId: string,
  cause: StoredRunCauseV1,
  routineName: (routineId: string) => Promise<string | undefined>,
): Promise<StoredRunCauseV1> {
  if (cause.kind !== "routine" || cause.botId !== botId || !cause.id)
    return cause;
  const label = await routineName(cause.id).catch(() => undefined);
  return label ? { ...cause, label } : cause;
}

/** The cause of one of this Bot's runs, by id. */
export async function runCauseOfRunV1(
  botId: string,
  runId: string,
  readers: RunCauseReadersV1,
): Promise<StoredRunCauseV1> {
  const run = await readers.readRun(runId);
  return runCauseV1(botId, run?.admission?.origin, readers);
}
