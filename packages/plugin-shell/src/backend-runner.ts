import type {
  AgentEffectAdmission,
  AgentHandle,
} from "@frockbot/kernel-agent-loop/agent";
import {
  type PersistSessionEvents,
  type SessionEvent,
  type SkillRefV1,
  turnFailureMessage,
  type TurnTypeV1,
  validateToolOccurrenceJournal,
} from "@frockbot/kernel-contracts";
import type { ShellMountedComposition } from "./backend-composition.js";
import {
  BotTurnExecutionError,
  BotTurnReconciliationRequiredError,
  BotTurnRecoveryRequiredError,
} from "@frockbot/kernel-do";
import type { BotTurnCommand, BotTurnCompletion } from "./backend-contracts.js";
import {
  compactionInFlightV1,
  whenCompactionSettledV1,
} from "./compaction-scheduler.js";

export {
  BotTurnExecutionError,
  BotTurnReconciliationRequiredError,
  BotTurnRecoveryRequiredError,
};

function appendedSessionEvents(
  previous: readonly SessionEvent[],
  candidate: readonly SessionEvent[],
): SessionEvent[] {
  if (
    candidate.length < previous.length ||
    previous.some(
      (event, index) =>
        JSON.stringify(event) !== JSON.stringify(candidate[index]),
    )
  ) {
    throw new Error("candidate changed durable session history");
  }
  return structuredClone(candidate.slice(previous.length));
}

/**
 * Classifies one finished Agent handle against the durable history it started
 * from. Shared by the Composition-mounted and the resident execution paths, so
 * both reach exactly the same durable terminal, recovery, or reconciliation
 * outcome.
 */
function settleBotTurn(
  handle: AgentHandle,
  command: BotTurnCommand,
  previousEvents: readonly SessionEvent[],
): BotTurnCompletion {
  const events = [...handle.agent.session.events];
  const turnStart = events.findLast((event) => event.type === "turn/start");
  const currentTurn =
    turnStart?.type === "turn/start" ? turnStart.turn : undefined;
  const terminalTurn = events.findLast(
    (event) => event.type === "turn/end" && event.turn === currentTurn,
  );
  if (!terminalTurn || terminalTurn.type !== "turn/end") {
    const unresolvedTool = [
      ...validateToolOccurrenceJournal(events).values(),
    ].find((entry) => entry.intent && !entry.result);
    if (unresolvedTool) {
      throw new BotTurnReconciliationRequiredError(
        `Tool effect "${unresolvedTool.occurrence.occurrenceId}" requires reconciliation`,
        appendedSessionEvents(previousEvents, events),
      );
    }
    const reconciliation = events.findLast(
      (event) =>
        event.type === "model/reconciliation-required" &&
        event.turn === currentTurn,
    );
    if (reconciliation?.type === "model/reconciliation-required") {
      throw new BotTurnReconciliationRequiredError(
        reconciliation.reason,
        appendedSessionEvents(previousEvents, events),
      );
    }
    const latestRequest = events.findLast(
      (event) => event.type === "model/request" && event.turn === currentTurn,
    );
    const hasDurableOutcome =
      latestRequest?.type === "model/request" &&
      events.some(
        (event) =>
          (event.type === "assistant/message" ||
            event.type === "model/effect-not-started") &&
          event.requestId === latestRequest.request.requestId,
      );
    if (hasDurableOutcome) {
      throw new BotTurnRecoveryRequiredError(
        appendedSessionEvents(previousEvents, events),
      );
    }
    throw new BotTurnExecutionError(
      "Bot turn did not reach a durable terminal state",
      appendedSessionEvents(previousEvents, events),
    );
  }
  if (terminalTurn.outcome !== "completed") {
    throw new BotTurnExecutionError(
      turnFailureMessage(terminalTurn.outcome, terminalTurn.reason),
      appendedSessionEvents(previousEvents, events),
    );
  }
  const message = handle.agent.session.deriveMessages().at(-1);
  const assistantText = message?.role === "assistant" ? message.content : "";
  return {
    runId: command.runId,
    // A Turn the Bot ended by speaking through `send_to_user` writes no
    // assistant message at all, so the derived text falls back to the last
    // text payload it sent. Every other payload leaves the text empty and
    // reaches the client as a projected `send/to-user` event instead.
    text: assistantText || lastSentTextV1(events),
    events: appendedSessionEvents(previousEvents, events),
  };
}

/** The last `text` payload the Turn sent, or `""` when it sent none. */
function lastSentTextV1(events: readonly SessionEvent[]): string {
  const sent = events.findLast(
    (event) => event.type === "send/to-user" && event.payload.type === "text",
  );
  return sent?.type === "send/to-user" && sent.payload.type === "text"
    ? sent.payload.text
    : "";
}

function turnExecutionError(
  error: unknown,
  previousEvents: readonly SessionEvent[],
  events: readonly SessionEvent[],
): never {
  if (
    error instanceof BotTurnExecutionError ||
    error instanceof BotTurnReconciliationRequiredError ||
    error instanceof BotTurnRecoveryRequiredError
  ) {
    throw error;
  }
  throw new BotTurnExecutionError(
    error instanceof Error ? error.message : "Bot turn failed",
    appendedSessionEvents(previousEvents, events),
  );
}

export interface ExecuteBotTurnOptions {
  command: BotTurnCommand;
  previousEvents: readonly SessionEvent[];
  /** The mounted Composition for the generation this Turn was pinned to. */
  composition: ShellMountedComposition;
  resume?: boolean;
}

export interface ExecuteDirectToolTurnOptions {
  command: BotTurnCommand & {
    directTool: NonNullable<BotTurnCommand["directTool"]>;
  };
  previousEvents: readonly SessionEvent[];
  composition: ShellMountedComposition;
  admitEffect(effect: AgentEffectAdmission): Promise<boolean>;
  signal: AbortSignal;
}

/**
 * Runs a Package-page tool as one ordinary durable Turn, without a model call.
 * The same Session journal and effect fence make retry/recovery identical to a
 * model-selected tool occurrence.
 */
export async function executeDirectToolTurn(
  options: ExecuteDirectToolTurnOptions,
): Promise<BotTurnCompletion> {
  const { command, composition, previousEvents, admitEffect, signal } = options;
  const session = composition.runtime.agent.agent.session;
  const call = {
    id: command.runId,
    name: "call_dynamic_tool",
    input: {
      namespace: command.directTool.packageId,
      toolName: command.directTool.name,
      arguments: command.directTool.input,
      mcpDetails: {
        description: `The User invoked ${command.directTool.name} from the Package UI.`,
      },
    },
  };
  try {
    let turnStart = [...session.events].findLast(
      (event) =>
        event.type === "turn/start" &&
        !session.events.some(
          (candidate) =>
            candidate.type === "turn/end" && candidate.turn === event.turn,
        ),
    );
    if (!turnStart || turnStart.type !== "turn/start") {
      const turn = session.nextTurn();
      const messageId = `iframe:${command.runId}`;
      session.appendBatch([
        { type: "input/queued", messageId, text: command.text },
        { type: "turn/start", turn },
        {
          type: "composition/pinned",
          turn,
          generationId: composition.generation.generationId,
          artifactSetHash: composition.generation.artifactSetHash,
        },
        { type: "turn/admission", turn, turnType: "chat" },
        { type: "input/admitted", messageId, turn },
        { type: "step/start", turn, step: 1 },
        { type: "user/message", turn, step: 1, messageId, text: command.text },
        {
          type: "assistant/message",
          turn,
          step: 1,
          requestId: `iframe:${command.runId}`,
          text: "",
          toolCalls: [call],
        },
      ]);
      await session.flush();
      turnStart = session.events.findLast(
        (event) => event.type === "turn/start" && event.turn === turn,
      );
    }
    if (!turnStart || turnStart.type !== "turn/start") {
      throw new Error("Package UI tool Turn has no durable start");
    }
    const turn = turnStart.turn;
    const occurrenceId = `tool:${turn}:1:0`;
    const journal = validateToolOccurrenceJournal(session.events);
    const existing = journal.get(occurrenceId);
    if (!existing) throw new Error("Package UI tool occurrence is unavailable");

    if (!existing.result) {
      const context = {
        botId: composition.runtime.agent.agent.botId,
        agentId: composition.runtime.agent.agent.id,
        sessionId: command.sessionId,
        compositionGenerationId: composition.generation.generationId,
        effectId: occurrenceId,
        toolCall: call,
        turnType: "chat" as const,
        signal,
      };
      const preparation = await composition.root.tools.prepare(call, context);
      let result;
      if (existing.intent) {
        if (preparation.kind !== "ready") {
          throw new BotTurnReconciliationRequiredError(
            `Tool effect "${occurrenceId}" cannot be reconciled because its definition is unavailable`,
            appendedSessionEvents(previousEvents, session.events),
          );
        }
        const reconciled = await composition.root.tools.reconcilePrepared(
          preparation,
          context,
        );
        if (reconciled.status === "unavailable") {
          throw new BotTurnReconciliationRequiredError(
            reconciled.reason,
            appendedSessionEvents(previousEvents, session.events),
          );
        }
        result = reconciled.result;
      } else {
        session.append({
          type: "tool/call",
          turn,
          step: 1,
          occurrenceId,
          name: call.name,
          input: call.input,
        });
        await session.flush();
        if (preparation.kind === "denied") {
          result = preparation.result;
        } else {
          if (!(await admitEffect({ kind: "tool", effectId: occurrenceId }))) {
            session.appendBatch([
              {
                type: "tool/result",
                turn,
                step: 1,
                occurrenceId,
                name: call.name,
                content: "Cancelled before tool execution started.",
                isError: true,
                status: "interrupted",
              },
              { type: "step/end", turn, step: 1, outcome: "cancelled" },
              { type: "turn/end", turn, outcome: "cancelled" },
            ]);
            await session.flush();
            throw new Error("Package UI tool effect was fenced by Stop");
          }
          try {
            result = await composition.root.tools.executePrepared(
              preparation,
              context,
            );
          } catch (error) {
            if (signal.aborted || !preparation.idempotent) {
              throw new BotTurnReconciliationRequiredError(
                `Tool effect "${occurrenceId}" outcome is uncertain`,
                appendedSessionEvents(previousEvents, session.events),
              );
            }
            result = {
              content:
                error instanceof Error
                  ? error.message
                  : "Tool execution failed",
              isError: true,
            };
          }
        }
      }
      session.append({
        type: "tool/result",
        turn,
        step: 1,
        occurrenceId,
        name: call.name,
        content: result.content,
        isError: result.isError,
        status: "completed",
        ...(result.attachments?.length
          ? { attachments: result.attachments }
          : {}),
      });
      await session.flush();
    }
    const hasTerminal = session.events.some(
      (event) => event.type === "turn/end" && event.turn === turn,
    );
    if (!hasTerminal) {
      session.appendBatch([
        { type: "step/end", turn, step: 1, outcome: "completed" },
        { type: "turn/end", turn, outcome: "completed" },
      ]);
      await session.flush();
    }
    return {
      runId: command.runId,
      text: "",
      events: appendedSessionEvents(previousEvents, session.events),
    };
  } finally {
    await composition.dispose();
  }
}

export async function executeBotTurn(
  options: ExecuteBotTurnOptions,
): Promise<BotTurnCompletion> {
  const { command, previousEvents, composition, resume } = options;
  const runtime = composition.runtime;
  try {
    if (resume) runtime.agent.agent.resume();
    else {
      runtime.agent.agent.send({
        text: command.text,
        ...(command.skills ? { skills: command.skills } : {}),
      });
    }
    await runtime.agent.agent.whenIdle();
    return settleBotTurn(runtime.agent, command, previousEvents);
  } catch (error) {
    return turnExecutionError(error, previousEvents, [
      ...runtime.agent.agent.session.events,
    ]);
  } finally {
    // ADR 0030: a compaction outlives the Turn that triggered it, and it runs
    // on this Composition's model binding — so the Composition outlives the
    // Turn too, and only by as long as the compaction does. Awaiting the
    // disposal here would put the summariser back in the latency path, which
    // is the whole defect. The next admission aborts anything still running,
    // so this can never stack up.
    if (compactionInFlightV1(command.sessionId)) {
      void whenCompactionSettledV1(command.sessionId).then(
        () => composition.dispose(),
        () => composition.dispose(),
      );
    } else {
      await composition.dispose();
    }
  }
}

export interface ExecuteResidentBotTurnOptions {
  botId: string;
  command: BotTurnCommand;
  previousEvents: readonly SessionEvent[];
  persistSessionEvents: PersistSessionEvents;
  beforeStart(): Promise<boolean>;
  admitEffect(effect: AgentEffectAdmission): Promise<boolean>;
  resume?: boolean;
}

export interface ResidentTurnRuntime {
  execute(input: {
    botId: string;
    sessionId: string;
    runId: string;
    previousEvents: readonly SessionEvent[];
    persistSessionEvents: PersistSessionEvents;
    beforeStart(): Promise<boolean>;
    admitEffect(effect: AgentEffectAdmission): Promise<boolean>;
    resume?: boolean;
    text: string;
    skills?: SkillRefV1[];
    turnType: TurnTypeV1;
    subagentRole?: string;
  }): Promise<AgentHandle>;
}

/**
 * Runs one Turn on the Bot Durable Object's resident Cordis root. The root
 * outlives the Turn, so nothing is disposed here; the durable effect fence and
 * the session persistence are the caller's.
 */
export async function executeResidentBotTurn(
  runtime: ResidentTurnRuntime,
  options: ExecuteResidentBotTurnOptions,
): Promise<BotTurnCompletion> {
  const {
    botId,
    command,
    previousEvents,
    persistSessionEvents,
    beforeStart,
    admitEffect,
    resume,
  } = options;
  let handle: AgentHandle | undefined;
  try {
    handle = await runtime.execute({
      botId,
      sessionId: command.sessionId,
      runId: command.runId,
      previousEvents,
      persistSessionEvents,
      beforeStart,
      admitEffect,
      resume,
      text: command.text,
      ...(command.skills ? { skills: command.skills } : {}),
      turnType: command.turnType ?? "chat",
      ...(command.subagentRole ? { subagentRole: command.subagentRole } : {}),
    });
    return settleBotTurn(handle, command, previousEvents);
  } catch (error) {
    turnExecutionError(
      error,
      previousEvents,
      handle ? [...handle.agent.session.events] : [...previousEvents],
    );
  }
}
