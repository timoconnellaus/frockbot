import { Session, type SessionEvent } from "@frockbot/agent-core";
import type { StoredRun } from "./contracts.js";

export type BotRunRecoveryPlan =
  | { kind: "complete"; responseText: string }
  | { kind: "restart"; previous: SessionEvent[] }
  | { kind: "reconcile"; repairs: SessionEvent[] };

export function planBotRunRecovery(
  run: StoredRun,
  latest: readonly SessionEvent[],
): BotRunRecoveryPlan {
  const terminalTurn = run.events.findLast(
    (event) => event.type === "turn/end",
  );
  const lastAssistant = run.events.findLast(
    (event) => event.type === "assistant/message",
  );
  if (terminalTurn?.type === "turn/end") {
    return {
      kind: "complete",
      responseText:
        lastAssistant?.type === "assistant/message" ? lastAssistant.text : "",
    };
  }
  const hasExternalIntent = run.events.some(
    (event) => event.type === "model/request" || event.type === "tool/call",
  );
  if (!hasExternalIntent) {
    return {
      kind: "restart",
      previous: [...latest.slice(0, run.previousEventCount ?? 0)],
    };
  }
  const session = new Session(run.sessionId, () => {}, latest);
  return { kind: "reconcile", repairs: session.reconcileForResume() };
}
