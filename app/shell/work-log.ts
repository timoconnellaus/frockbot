// The Work log: everything one Bot did, Turn by Turn and step by step.
//
// The conversation shows what was said; the Work view shows one reply's tools;
// the audit page shows effects across Bots. This is the whole of it for one
// Bot — every model request, Jev check, tool call, memory and skill read,
// plugin effect, Computer operation, retry and compaction the durable log
// recorded — projected here so every client draws the same words.
//
// It reads the bounded event projections, never a full prompt, and infers
// nothing: a count or a duration the log did not record is left out rather
// than estimated.
import {
  decodeProtocol,
  type WorkLogEntry,
  type WorkLogField,
  type WorkLogLink,
  type WorkLogPage,
  type WorkLogSection,
  type WorkLogTotals,
  type WorkLogTurn,
} from "@frockbot/core/protocol-schemas";
import {
  approvalKeyV1,
  decodeApprovalRecordV1,
  type ApprovalRecordV1,
} from "./approvals.js";
import type { ShellBotStateV1 } from "./backend-state.js";
import { decodeRunCursorV1 } from "./run-cursor.js";
import { clientToolCallNameV1 } from "./run-protocol.js";

/** Turns per page. A Turn can carry hundreds of entries, so pages stay short. */
export const WORK_LOG_PAGE_TURNS_V1 = 8;
export const WORK_LOG_MAX_ENTRIES_V1 = 400;
/** Past this a Turn keeps its rows and drops their detail sections. */
const MAX_TURN_BYTES = 192_000;
const SECTION_CHARS = 4_000;
const TITLE_CHARS = 200;
const DETAIL_CHARS = 400;
const FIELD_CHARS = 500;
const INPUT_CHARS = 400;

export interface WorkLogQueryV1 {
  schemaVersion: 1;
  before?: string;
}

export function decodeWorkLogQueryV1(input: unknown): WorkLogQueryV1 {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("work log query must be an object");
  }
  const record = input as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    Object.keys(record).some(
      (key) => key !== "schemaVersion" && key !== "before",
    )
  ) {
    throw new Error("work log query is invalid");
  }
  if (record.before === undefined) return { schemaVersion: 1 };
  if (typeof record.before !== "string") {
    throw new Error("work log cursor is invalid");
  }
  return { schemaVersion: 1, before: decodeRunCursorV1(record.before) };
}

/** One page of the Bot's Turns, newest first. */
export async function readWorkLogV1(
  state: ShellBotStateV1,
  input: unknown,
): Promise<WorkLogPage> {
  const query = decodeWorkLogQueryV1(input);
  const candidates = await state.authority.listRunIndex({
    limit: WORK_LOG_PAGE_TURNS_V1 + 1,
    ...(query.before ? { before: query.before } : {}),
  });
  const page = candidates.slice(0, WORK_LOG_PAGE_TURNS_V1);
  const turns: WorkLogTurn[] = [];
  for (const candidate of page) {
    // One record this build cannot read costs its own row, never the page:
    // the log is where a person goes when something already looks wrong.
    try {
      const projected = await state.authority.readRunEventProjections(
        candidate.runId,
      );
      if (!projected) continue;
      const approvals = await readApprovals(state, projected.events);
      turns.push(
        decodeProtocol(
          "WorkLogTurn",
          projectWorkLogTurnV1(projected.run, projected.events, approvals),
        ),
      );
    } catch {
      continue;
    }
  }
  return decodeProtocol("WorkLogPage", {
    schemaVersion: 1,
    turns,
    ...(candidates.length > WORK_LOG_PAGE_TURNS_V1
      ? { nextCursor: page.at(-1)!.cursor }
      : {}),
  });
}

async function readApprovals(
  state: ShellBotStateV1,
  events: readonly unknown[],
): Promise<Map<string, ApprovalRecordV1>> {
  const approvals = new Map<string, ApprovalRecordV1>();
  for (const event of events) {
    const payload = obj(obj(event).payload);
    if (obj(event).type !== "send/to-user" || payload.type !== "approval") {
      continue;
    }
    const approvalId = str(payload.approvalId);
    if (!approvalId) continue;
    const stored = await state.ctx.storage.get<unknown>(
      approvalKeyV1(approvalId),
    );
    if (stored === undefined) continue;
    try {
      approvals.set(approvalId, decodeApprovalRecordV1(stored));
    } catch {
      // A record this build cannot read leaves the row saying what was asked.
    }
  }
  return approvals;
}

export interface WorkLogRunV1 {
  runId: string;
  acceptedAt: string;
  status: WorkLogTurn["status"];
  input: string;
  failure?: string;
  admission?: { turnType?: string; origin?: { kind: string } };
}

const VIA_BY_ORIGIN: Record<string, string> = {
  routine: "Routine",
  email: "Email",
  voice: "Voice call",
  bot: "Another Bot",
  handoff: "Hand-off",
  subagent: "Subagent",
  group: "Group chat",
  "input-delivery": "Follow-up",
};

const VIA_BY_TURN_TYPE: Record<string, string> = {
  chat: "You",
  automation: "Routine",
  agent: "Another Bot",
  subagent: "Subagent",
};

const OUTCOME_WORDS: Record<string, string> = {
  completed: "Completed",
  blocked: "Blocked",
  cancelled: "Stopped",
  interrupted: "Interrupted",
  "model-error": "The model failed",
  "tool-error": "A tool failed",
};

/** One Turn, as the Work log reads it. Pure, for tests. */
export function projectWorkLogTurnV1(
  run: WorkLogRunV1,
  rawEvents: readonly unknown[],
  approvals: ReadonlyMap<string, ApprovalRecordV1> = new Map(),
): WorkLogTurn {
  const b = new TurnBuilder(approvals);
  for (const raw of rawEvents) b.add(obj(raw));
  const origin = run.admission?.origin?.kind;
  const via =
    (origin && VIA_BY_ORIGIN[origin]) ??
    VIA_BY_TURN_TYPE[run.admission?.turnType ?? "chat"] ??
    "You";
  const entries = b.entries.slice(0, WORK_LOG_MAX_ENTRIES_V1);
  const omitted = b.entries.length - entries.length;
  const outcome = b.outcome
    ? [OUTCOME_WORDS[b.outcome] ?? b.outcome, b.outcomeReason]
        .filter(Boolean)
        .join(" · ")
    : run.failure;
  const turn: WorkLogTurn = {
    runId: run.runId,
    at: instant(run.acceptedAt) ?? new Date(0).toISOString(),
    status: run.status,
    via,
    input: cut(run.input, INPUT_CHARS),
    ...(b.turn === undefined ? {} : { turn: b.turn }),
    ...(b.durationMs === undefined ? {} : { durationMs: b.durationMs }),
    ...(outcome ? { outcome: cut(outcome, TITLE_CHARS) } : {}),
    totals: b.totals,
    entries,
    ...(omitted > 0 ? { omittedEntries: omitted } : {}),
  };
  if (JSON.stringify(turn).length > MAX_TURN_BYTES) {
    for (const entry of turn.entries) delete entry.sections;
  }
  return turn;
}

type Event = Record<string, unknown>;

class TurnBuilder {
  readonly entries: WorkLogEntry[] = [];
  readonly totals: WorkLogTotals = {
    steps: 0,
    modelRequests: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    toolCalls: 0,
    toolErrors: 0,
    jevChecks: 0,
    retries: 0,
    computerMs: 0,
  };
  turn: number | undefined;
  durationMs: number | undefined;
  outcome: string | undefined;
  outcomeReason: string | undefined;
  private turnStartedAt: number | undefined;
  private readonly models = new Map<string, WorkLogEntry>();
  private requests = 0;
  /** Which request asked for the calls that follow it, by its number. */
  private readonly requestNumbers = new Map<string, number>();
  private lastAsking: number | undefined;
  /** Jev's call reviews, waiting for the call they were about. */
  private readonly callReviews = new Map<string, WorkLogLink>();
  private readonly tools = new Map<
    string,
    { entry: WorkLogEntry; at: number }
  >();
  private readonly pluginCalls = new Map<
    string,
    { entry: WorkLogEntry; at: number }
  >();
  private compactionStartedAt: number | undefined;

  constructor(
    private readonly approvals: ReadonlyMap<string, ApprovalRecordV1>,
  ) {}

  add(event: Event): void {
    const type = str(event.type);
    const seq = num(event.seq);
    const at = instant(event.timestamp);
    if (!type || seq === undefined || !at) return;
    const time = Date.parse(at);
    const step = num(event.step);
    if (step !== undefined && step > this.totals.steps)
      this.totals.steps = step;
    const push = (entry: Omit<WorkLogEntry, "seq" | "at" | "step">) => {
      const full: WorkLogEntry = {
        seq,
        at,
        ...(step === undefined ? {} : { step }),
        ...entry,
        title: cut(entry.title, TITLE_CHARS) || type,
      };
      if (entry.kind === "compaction" && this.turnStartedAt === undefined) {
        full.beforeTurn = true;
      }
      if (entry.detail !== undefined) {
        const detail = cut(entry.detail, DETAIL_CHARS);
        if (detail) full.detail = detail;
        else delete full.detail;
      }
      this.entries.push(full);
      return full;
    };
    switch (type) {
      case "turn/start":
        this.turn = num(event.turn);
        this.turnStartedAt = time;
        return;
      case "turn/end":
        this.outcome = str(event.outcome);
        this.outcomeReason = str(event.reason);
        if (this.turnStartedAt !== undefined) {
          this.durationMs = Math.max(0, time - this.turnStartedAt);
        }
        return;
      case "user/message": {
        const attachments = arr(event.attachments).length;
        push({
          kind: "input",
          title: firstLine(str(event.text)) || "Message",
          ...(attachments > 0
            ? { detail: `${attachments} attachment${plural(attachments)}` }
            : {}),
          ...withSections(sec("Message", str(event.text))),
        });
        return;
      }
      case "input/cancelled":
        push({
          kind: "system",
          title: "Input cancelled",
          detail: str(event.reason),
        });
        return;
      case "supervision/turn-start":
        return this.jev(
          push,
          event,
          "Turn read",
          turnReadDetail(obj(event.directive)),
          obj(event.directive),
          {
            verdict: capital(words(obj(event.directive).complexity)) ?? "Read",
          },
        );
      case "supervision/step":
        return this.jev(
          push,
          event,
          "Step review",
          stepDetail(obj(event.decision)),
          obj(event.decision),
          {
            verdict: capital(str(obj(event.decision).text)) ?? "Reviewed",
            isError: str(obj(event.decision).text) === "withhold",
          },
        );
      case "supervision/send": {
        const decision = obj(event.decision);
        return this.jev(
          push,
          event,
          bool(event.finish) ? "Final reply review" : "Send review",
          [str(decision.send), words(decision.reason)]
            .filter(Boolean)
            .join(" · "),
          decision,
          {
            verdict: capital(str(decision.send)) ?? "Reviewed",
            isError: str(decision.send) === "withhold",
          },
        );
      }
      case "supervision/call": {
        const decision = obj(event.decision);
        const rejected = str(decision.decision) === "reject";
        const verdict = capital(str(decision.decision)) ?? "Reviewed";
        this.jev(
          push,
          event,
          `Call review · ${str(event.tool) ?? "tool"}`,
          [str(decision.decision), words(decision.reasonCode)]
            .filter(Boolean)
            .join(" · "),
          decision,
          { verdict, isError: rejected, label: "Call review" },
        );
        // The review belongs on the call's own chain too, wherever it lands.
        const link: WorkLogLink = {
          kind: "jev",
          title: `Jev · ${verdict.toLowerCase()}`,
          ...(words(decision.reasonCode)
            ? { detail: words(decision.reasonCode)! }
            : {}),
          ...optionalDuration(num(event.latencyMs)),
          ...(rejected ? { isError: true } : {}),
        };
        const id = str(event.occurrenceId);
        const call = id ? this.tools.get(id) : undefined;
        if (call) addLink(call.entry, link, true);
        else if (id) this.callReviews.set(id, link);
        return;
      }
      case "supervision/progress": {
        const decision = obj(event.decision);
        const signals = arr(decision.signals).map(words).filter(Boolean);
        return this.jev(
          push,
          event,
          "Progress check",
          bool(decision.stuck)
            ? `stuck · ${signals.join(", ")}`
            : "making progress",
          decision,
          {
            verdict: bool(decision.stuck) ? "Stuck" : "On track",
            isError: bool(decision.stuck),
          },
        );
      }
      case "supervision/outcome": {
        const decision = obj(event.decision);
        return this.jev(
          push,
          event,
          "Outcome check",
          [words(decision.status), words(decision.cause)]
            .filter(Boolean)
            .join(" · "),
          decision,
          { verdict: capital(words(decision.status)) ?? "Checked" },
        );
      }
      case "supervision/question": {
        const route = obj(event.route);
        return this.jev(
          push,
          event,
          "Question routing",
          `answered by the ${str(route.answerer) ?? "conversation"}`,
          route,
          {
            verdict:
              str(route.answerer) === "person"
                ? "Ask the person"
                : "From the conversation",
          },
        );
      }
      case "model/request": {
        const request = obj(event.request);
        const requestId = str(request.requestId);
        const messages =
          num(request.messageCount) ?? arr(request.messages).length;
        const tools = num(request.toolCount) ?? arr(request.tools).length;
        this.totals.modelRequests += 1;
        this.requests += 1;
        const cutRequest = obj(request.excerpt);
        const lastMessage = arr(request.messages).at(-1);
        const entry = push({
          kind: "model",
          title: "Model request",
          label: `Request #${this.requests}`,
          ...withSections(
            sec(
              "System prompt",
              str(cutRequest.system) ?? str(request.system),
              false,
              "prompt",
            ),
            sec(
              "Last message in",
              str(cutRequest.lastMessage) ??
                (lastMessage === undefined ? undefined : pretty(lastMessage)),
              true,
              "prompt",
            ),
          ),
          fields: fields([
            ["Provider", providerName(str(request.provider))],
            ["Model", str(request.model)],
            ["Messages", String(messages)],
            ["Tools offered", String(tools)],
            ["Request", requestId],
          ]),
        });
        if (requestId) {
          this.models.set(requestId, entry);
          this.requestNumbers.set(requestId, this.requests);
        }
        return;
      }
      case "model/usage": {
        const entry = this.models.get(str(event.requestId) ?? "");
        const tokens = {
          input: num(event.inputTokens) ?? 0,
          cachedInput: num(event.cachedInputTokens) ?? 0,
          output: num(event.outputTokens) ?? 0,
          reasoning: num(event.reasoningTokens) ?? 0,
        };
        this.totals.inputTokens += tokens.input;
        this.totals.cachedInputTokens += tokens.cachedInput;
        this.totals.outputTokens += tokens.output;
        this.totals.reasoningTokens += tokens.reasoning;
        if (!entry) return;
        entry.tokens = tokens;
        const latency = num(event.latencyMs);
        if (latency !== undefined) entry.durationMs = latency;
        if (bool(event.estimated)) {
          entry.fields = fields([
            ...pairs(entry.fields),
            ["Usage", "estimated — the provider reported none"],
          ]);
        }
        return;
      }
      case "model/retry": {
        this.totals.retries += 1;
        const delay = num(event.delayMs);
        push({
          kind: "retry",
          title: "Model call retried",
          detail: [
            str(event.classification),
            `attempt ${num(event.attempt) ?? "?"}`,
            delay === undefined ? undefined : `waited ${seconds(delay)}`,
          ]
            .filter(Boolean)
            .join(" · "),
          ...(delay === undefined ? {} : { durationMs: delay }),
        });
        return;
      }
      case "model/response-failed":
        push({
          kind: "retry",
          title: "Model reply could not be read",
          isError: true,
          ...withSections(sec("Failure", pretty(event.failure), true)),
        });
        return;
      case "model/response-format-note":
        push({
          kind: "system",
          title: "Model reply format note",
          ...withSections(sec("Note", pretty(event.note), true)),
        });
        return;
      case "assistant/message": {
        const entry = this.models.get(str(event.requestId) ?? "");
        if (!entry) return;
        const text = str(event.text) ?? "";
        const calls = arr(event.toolCalls).map((call) =>
          clientToolCallNameV1({
            name: str(obj(call).name) ?? "tool",
            input: obj(call).input ?? obj(call).arguments,
          }),
        );
        const callWords =
          calls.length === 0
            ? "no tool calls"
            : `${calls.length} tool call${plural(calls.length)}`;
        entry.title = cut(
          firstLine(text) ||
            (calls.length > 0 ? `Called ${calls.join(", ")}` : "No reply text"),
          TITLE_CHARS,
        );
        entry.detail = callWords;
        appendSections(
          entry,
          sec("What the model said", text, false, "output"),
          sec("Tool calls", calls.join("\n"), true, "tools"),
          excerpt(event),
        );
        this.lastAsking = this.requestNumbers.get(str(event.requestId) ?? "");
        return;
      }
      case "tool/call": {
        this.totals.toolCalls += 1;
        const name = clientToolCallNameV1({
          name: str(event.name) ?? "tool",
          input: event.input,
        });
        const id = str(event.occurrenceId);
        const review = id ? this.callReviews.get(id) : undefined;
        const entry = push({
          kind: "tool",
          title: name,
          label: "Tool call",
          chain: [
            ...(this.lastAsking === undefined
              ? []
              : [
                  {
                    kind: "model" as const,
                    title: `Asked for by request #${this.lastAsking}`,
                  },
                ]),
            ...(review ? [review] : []),
          ],
          ...withSections(
            sec("Input", pretty(event.input), true, "input"),
            excerpt(event),
          ),
          fields: fields([["Effect key", id]]),
        });
        if (entry.chain?.length === 0) delete entry.chain;
        if (id) {
          this.tools.set(id, { entry, at: time });
          this.callReviews.delete(id);
        }
        return;
      }
      case "tool/result": {
        const call = this.tools.get(str(event.occurrenceId) ?? "");
        const content = str(event.content);
        const isError = bool(event.isError);
        const interrupted = str(event.status) === "interrupted";
        if (isError) this.totals.toolErrors += 1;
        if (!call) return;
        const { entry } = call;
        entry.durationMs = Math.max(0, time - call.at);
        entry.detail = interrupted
          ? "interrupted"
          : firstLine(content) || (isError ? "failed" : "done");
        if (isError || interrupted) entry.isError = true;
        addLink(entry, {
          kind: "tool",
          title: interrupted ? "Interrupted" : isError ? "Failed" : "Ran",
          ...(firstLine(content)
            ? { detail: cut(firstLine(content), 200) }
            : {}),
          ...optionalDuration(entry.durationMs),
          ...(isError || interrupted ? { isError: true } : {}),
        });
        appendSections(
          entry,
          sec(isError ? "Error" : "Result", content, true, "result"),
          excerpt(event),
        );
        return;
      }
      case "package/tool-call": {
        const entry = push({
          kind: "plugin",
          title: `${str(event.packageId) ?? "plugin"} · ${str(event.name) ?? "tool"}`,
          ...withSections(sec("Input", pretty(event.input), true, "input")),
        });
        const id = str(event.callId);
        if (id) this.pluginCalls.set(id, { entry, at: time });
        return;
      }
      case "package/tool-result": {
        const call = this.pluginCalls.get(str(event.callId) ?? "");
        if (!call) return;
        const content = str(event.content);
        call.entry.durationMs = Math.max(0, time - call.at);
        call.entry.detail = firstLine(content) || "done";
        if (bool(event.isError)) call.entry.isError = true;
        appendSections(
          call.entry,
          sec(
            bool(event.isError) ? "Error" : "Result",
            content,
            true,
            "result",
          ),
        );
        return;
      }
      case "package/model-usage": {
        const cost = num(event.costMicros);
        push({
          kind: "plugin",
          title: `${str(event.packageId) ?? "Plugin"} asked a model`,
          // Usage reads as a share of the plan where people glance; the exact
          // charge stays in the row's fields for whoever opens it.
          detail: str(event.model),
          tokens: {
            input: num(event.inputTokens) ?? 0,
            cachedInput: num(event.cachedInputTokens) ?? 0,
            output: num(event.outputTokens) ?? 0,
            reasoning: num(event.reasoningTokens) ?? 0,
          },
          ...optionalDuration(num(event.latencyMs)),
          fields: fields([
            ["Plugin", str(event.packageId)],
            ["Model", str(event.model)],
            ["Cost", cost === undefined ? undefined : dollars(cost)],
          ]),
        });
        return;
      }
      case "package/author-intent":
        push({
          kind: "plugin",
          title: `Writing plugin ${str(event.packageId) ?? ""}`,
        });
        return;
      case "package/authored":
        push({
          kind: "plugin",
          title: `Built plugin ${str(event.packageId) ?? ""}`,
          detail: str(event.version)
            ? `version ${str(event.version)}`
            : undefined,
          fields: fields([["Generation", str(event.generationId)]]),
        });
        return;
      case "package/effect-failed":
        push({
          kind: "plugin",
          title:
            str(event.effect) === "undo"
              ? "Plugin undo failed"
              : "Plugin build failed",
          detail: str(event.reason),
          isError: true,
        });
        return;
      case "package/hook-failed":
        push({
          kind: "plugin",
          title: `Hook failed · ${str(event.packageId) ?? "plugin"}`,
          detail: [str(event.event), str(event.message)]
            .filter(Boolean)
            .join(" · "),
          isError: true,
        });
        return;
      case "package/undo-intent":
        push({ kind: "plugin", title: "Undoing a plugin change" });
        return;
      case "package/undo-recorded":
        push({
          kind: "plugin",
          title: "Plugin change undone",
          fields: fields([["Back to", str(event.targetGenerationId)]]),
        });
        return;
      case "skill/injected": {
        const skills = arr(event.skills).map(
          (skill) => str(obj(skill).name) ?? str(obj(skill).path) ?? "skill",
        );
        const refusals = arr(event.refusals).map(
          (refusal) =>
            `${str(obj(refusal).path) ?? "skill"}: ${str(obj(refusal).reason) ?? "refused"}`,
        );
        if (skills.length === 0 && refusals.length === 0 && !event.truncated)
          return;
        push({
          kind: "skill",
          title:
            skills.length > 0
              ? `Loaded ${skills.length} skill${plural(skills.length)}`
              : "No skills loaded",
          detail: skills.join(", "),
          ...(refusals.length > 0 ? { isError: true } : {}),
          ...withSections(sec("Refused", refusals.join("\n")), excerpt(event)),
        });
        return;
      }
      case "skill/invoked":
        push({
          kind: "skill",
          title: `Used skill ${str(obj(event.ref).name) ?? str(obj(event.ref).path) ?? ""}`,
        });
        return;
      case "skill/written":
        push({ kind: "skill", title: `Wrote skill ${str(event.path) ?? ""}` });
        return;
      case "memory/injected": {
        const facts = arr(event.facts)
          .map((fact) => str(obj(fact).text))
          .filter((text): text is string => !!text);
        const omissions = arr(event.omissions).map(
          (omission) =>
            `${str(obj(omission).scope) ?? "memory"}: ${str(obj(omission).reason) ?? "left out"}`,
        );
        if (facts.length === 0 && omissions.length === 0 && !event.truncated)
          return;
        push({
          kind: "memory",
          title:
            facts.length > 0
              ? `Recalled ${facts.length} fact${plural(facts.length)}`
              : "Recalled memory",
          detail: facts.slice(0, 3).join(" · "),
          ...withSections(
            sec("Facts", facts.map((fact) => `• ${fact}`).join("\n")),
            sec("Left out", omissions.join("\n")),
            excerpt(event),
          ),
        });
        return;
      }
      case "memory/written":
        push({
          kind: "memory",
          title:
            str(event.action) === "forget"
              ? "Forgot a memory"
              : "Saved a memory",
          detail: [str(event.tier), str(event.scope), str(event.path)]
            .filter(Boolean)
            .join(" · "),
        });
        return;
      case "image/generated":
        push({
          kind: "tool",
          title: "Made an image",
          detail: `${num(event.width) ?? "?"}×${num(event.height) ?? "?"} · ${str(event.model) ?? ""}`,
          fields: fields([["Saved to", str(event.path)]]),
        });
        return;
      case "computer/process": {
        const exit = num(event.exitCode);
        push({
          kind: "computer",
          title: `Process ${str(event.action) ?? ""} · ${str(event.processId) ?? ""}`,
          detail: [
            str(event.status),
            exit === undefined ? undefined : `exit ${exit}`,
          ]
            .filter(Boolean)
            .join(" · "),
          ...(exit !== undefined && exit !== 0 ? { isError: true } : {}),
        });
        return;
      }
      case "computer/timing": {
        const ms = obj(event.ms);
        const total = num(ms.total) ?? 0;
        this.totals.computerMs += total;
        const breakdown = computerBreakdown(ms);
        if (str(event.scope) === "tool") {
          const tool = str(event.tool);
          const target = [...this.tools.values()]
            .reverse()
            .find(
              ({ entry }) =>
                entry.title === tool || entry.title.endsWith(`/${tool}`),
            );
          if (target) {
            target.entry.fields = fields([
              ...pairs(target.entry.fields),
              ...breakdown,
            ]);
            return;
          }
        }
        push({
          kind: "computer",
          title:
            str(event.scope) === "turn-end"
              ? "Computer wrapped up"
              : `Computer · ${str(event.tool) ?? "call"}`,
          durationMs: total,
          fields: fields(breakdown),
        });
        return;
      }
      case "computer/sync": {
        const status = str(event.status) ?? "ok";
        const counts = (
          [
            "pulled",
            "pushed",
            "restored",
            "removed",
            "conflicts",
            "failures",
          ] as const
        )
          .map((key) => [key, num(event[key]) ?? 0] as const)
          .filter(([, value]) => value > 0)
          .map(([key, value]) => `${value} ${key}`);
        push({
          kind: "computer",
          title: `Workspace sync · ${str(event.reason) ?? ""}`,
          detail: [status, ...counts].join(" · "),
          ...(status === "ok" || status === "skipped" ? {} : { isError: true }),
          ...withSections(sec("Detail", str(event.detail))),
        });
        return;
      }
      case "send/to-user":
        return this.send(push, obj(event.payload));
      case "reply/to-caller":
        push({
          kind: "send",
          title: `Replied to the ${str(event.caller) === "voice" ? "call" : "asking Bot"}`,
          detail: firstLine(str(event.text)),
          ...withSections(sec("Reply", str(event.text))),
        });
        return;
      case "wake/parent":
        push({
          kind: "send",
          title: "Woke the Bot that asked",
          detail: firstLine(str(event.message)),
        });
        return;
      case "task/dispatched":
        push({
          kind: "task",
          title: `Started a ${bool(event.background) ? "background " : ""}task`,
          detail: firstLine(str(event.description)),
          fields: fields([
            ["Task", str(event.taskId)],
            ["Type", str(event.taskType)],
            ["Model", str(event.model)],
          ]),
          ...withSections(sec("Description", str(event.description))),
        });
        return;
      case "task/message":
        push({
          kind: "task",
          title: "Messaged a task",
          detail: firstLine(str(event.message)),
        });
        return;
      case "task/settled":
        push({
          kind: "task",
          title: `Task ${str(event.status) ?? "settled"}`,
          detail: firstLine(str(event.summary)),
          ...(str(event.status) === "failed" ? { isError: true } : {}),
        });
        return;
      case "task/stopped":
        push({
          kind: "task",
          title: "Task stopped",
          detail: `by ${str(event.requestedBy) === "user" ? "you" : "the Bot"}`,
        });
        return;
      case "conversation/compaction-intent":
        this.compactionStartedAt = time;
        return;
      case "conversation/compacted": {
        const identifiers = arr(event.identifiers).map(str).filter(Boolean);
        push({
          kind: "compaction",
          title: `Compacted turns ${num(event.fromTurn) ?? "?"}–${num(event.throughTurn) ?? "?"}`,
          detail: `${identifiers.length} name${plural(identifiers.length)} kept verbatim`,
          ...optionalDuration(
            this.compactionStartedAt === undefined
              ? undefined
              : Math.max(0, time - this.compactionStartedAt),
          ),
          fields: fields([
            ["Model", str(event.model)],
            ["Kept verbatim", identifiers.join(", ")],
          ]),
          ...withSections(sec("Summary the Bot now sees", str(event.summary))),
        });
        this.compactionStartedAt = undefined;
        return;
      }
      case "conversation/compaction-failed":
        push({
          kind: "compaction",
          title: "Compaction failed",
          detail: str(event.reason),
          isError: true,
        });
        return;
      case "conversation/tool-results-pruned": {
        const count = arr(event.results).length;
        push({
          kind: "compaction",
          title: `Pruned ${count} old tool result${plural(count)}`,
        });
        return;
      }
      case "bot/renamed":
        push({
          kind: "system",
          title: `Renamed to ${str(event.to) ?? ""}`,
          detail: `from ${str(event.from) ?? ""} · by ${str(event.namedBy) === "user" ? "you" : "the Bot"}`,
        });
        return;
      default:
        return;
    }
  }

  private jev(
    push: (entry: Omit<WorkLogEntry, "seq" | "at" | "step">) => WorkLogEntry,
    event: Event,
    title: string,
    detail: string,
    decision: Event,
    how: { verdict: string; isError?: boolean; label?: string },
  ): void {
    this.totals.jevChecks += 1;
    const judgments = arr(decision.judgments)
      .map((judgment) => {
        const j = obj(judgment);
        const question = str(j.question);
        if (!question) return undefined;
        return `${question}\n  ${str(j.answer) ?? "—"}${num(j.value) === undefined ? "" : ` (${num(j.value)})`}`;
      })
      .filter(Boolean)
      .join("\n");
    push({
      kind: "jev",
      title,
      label: how.label ?? title,
      verdict: cut(how.verdict, 40),
      detail,
      ...optionalDuration(num(event.latencyMs)),
      ...(how.isError ? { isError: true } : {}),
      fields: fields([
        ["Judge", str(decision.model)],
        ["Billing", "Platform overhead — not charged"],
      ]),
      ...withSections(sec("What Jev asked itself", judgments)),
    });
  }

  private send(
    push: (entry: Omit<WorkLogEntry, "seq" | "at" | "step">) => WorkLogEntry,
    payload: Event,
  ): void {
    const type = str(payload.type) ?? "message";
    if (type === "text") {
      push({
        kind: "send",
        title: firstLine(str(payload.text)) || "Sent a message",
        ...withSections(sec("Message", str(payload.text))),
      });
      return;
    }
    if (type === "approval") {
      const record = this.approvals.get(str(payload.approvalId) ?? "");
      const decision = record?.decision;
      push({
        kind: "send",
        title: `Asked you to approve: ${firstLine(str(payload.action)) ?? ""}`,
        detail:
          decision === undefined || decision === "pending"
            ? "waiting for you"
            : decision === "expired"
              ? "expired unanswered"
              : `${decision} by you${record?.decidedAt && record.createdAt ? ` in ${seconds(Date.parse(record.decidedAt) - Date.parse(record.createdAt))}` : ""}`,
        ...(decision === "denied" ? { isError: true } : {}),
        fields: fields([
          ["Risk", str(payload.risk) ?? record?.risk],
          ["Asked", record?.createdAt],
          ["Decided", record?.decidedAt],
        ]),
        ...withSections(sec("Action", str(payload.action))),
      });
      return;
    }
    const titles: Record<string, string> = {
      card: "Sent a card",
      attachment: `Sent a file${str(payload.name) ? ` · ${str(payload.name)}` : ""}`,
      widget: "Sent a widget",
      "secret-request": `Asked you for a secret · ${str(payload.secretName) ?? ""}`,
      "agent-card": `Introduced ${str(payload.title) ?? "a Bot"}`,
    };
    push({ kind: "send", title: titles[type] ?? `Sent ${type}` });
  }
}

function turnReadDetail(directive: Event): string {
  const capabilities = arr(directive.requiredCapabilities)
    .map(words)
    .filter(Boolean);
  return [
    words(directive.complexity),
    num(directive.consequence) === undefined
      ? undefined
      : `consequence ${num(directive.consequence)}`,
    words(directive.ambiguity),
    capabilities.length > 0 ? `needs ${capabilities.join(", ")}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

function stepDetail(decision: Event): string {
  const calls = arr(decision.calls).map(obj);
  const rejected = calls.filter(
    (call) => str(call.decision) === "reject",
  ).length;
  return [
    str(decision.text),
    calls.length === 0
      ? undefined
      : rejected > 0
        ? `${rejected} of ${calls.length} calls rejected`
        : `${calls.length} call${plural(calls.length)} allowed`,
    words(decision.responseAlignment),
  ]
    .filter(Boolean)
    .join(" · ");
}

function computerBreakdown(ms: Event): Array<[string, string | undefined]> {
  const part = (key: string) => {
    const value = num(ms[key]);
    return value === undefined ? undefined : millis(value);
  };
  return [
    ["Computer total", part("total")],
    ["Opening", part("attach")],
    ["Sync", part("sync")],
    ["Self-check", part("selfCheck")],
    ["Operation", part("operation")],
    [
      "Screenshot",
      num(obj(ms.capture).total) === undefined
        ? undefined
        : millis(num(obj(ms.capture).total)!),
    ],
  ];
}

function providerName(provider: string | undefined): string | undefined {
  if (provider === "frock-ai") return "Frock AI";
  return provider;
}

function obj(value: unknown): Event {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Event)
    : {};
}
function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}
function bool(value: unknown): boolean {
  return value === true;
}
function instant(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}
function cut(value: string | undefined, max: number): string {
  if (!value) return "";
  const chars = [...value];
  return chars.length <= max ? value : `${chars.slice(0, max - 1).join("")}…`;
}
function firstLine(value: string | undefined): string {
  return (
    (value ?? "")
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}
function plural(count: number): string {
  return count === 1 ? "" : "s";
}
function words(value: unknown): string | undefined {
  return str(value)?.replaceAll(/[_-]+/g, " ");
}
function pretty(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return undefined;
  }
}
function seconds(ms: number): string {
  return ms < 1_000 ? `${Math.round(ms)} ms` : `${(ms / 1_000).toFixed(1)} s`;
}
function millis(ms: number): string {
  return seconds(ms);
}
function dollars(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(micros < 10_000 ? 4 : 3)}`;
}
function capital(value: string | undefined): string | undefined {
  return value ? value[0]!.toUpperCase() + value.slice(1) : undefined;
}
/** Adds one step to the way a call got to run; a review goes before the run. */
function addLink(entry: WorkLogEntry, link: WorkLogLink, beforeRun = false) {
  const chain = [...(entry.chain ?? [])];
  const run = chain.findIndex(
    (existing) => existing.kind === "tool" && !beforeRun,
  );
  if (beforeRun) {
    const ran = chain.findIndex((existing) => existing.kind === "tool");
    chain.splice(ran === -1 ? chain.length : ran, 0, link);
  } else if (run === -1) chain.push(link);
  entry.chain = chain.slice(0, 8);
}
function optionalDuration(ms: number | undefined): { durationMs?: number } {
  return ms === undefined ? {} : { durationMs: ms };
}
function sec(
  label: string,
  text: string | undefined,
  mono = false,
  tab?: WorkLogSection["tab"],
): WorkLogSection[] {
  const body = cut(text?.trim(), SECTION_CHARS);
  return body
    ? [
        {
          label,
          text: body,
          ...(mono ? { mono } : {}),
          ...(tab ? { tab } : {}),
        },
      ]
    : [];
}
/** What a projection kept of an event too large to store inline. */
function excerpt(event: Event): WorkLogSection[] {
  if (!event.truncated) return [];
  return sec(
    "Excerpt — the full event is too large to show",
    str(event.excerpt),
    true,
  );
}
function withSections(...lists: WorkLogSection[][]): {
  sections?: WorkLogSection[];
} {
  const sections = lists.flat().slice(0, 6);
  return sections.length > 0 ? { sections } : {};
}
/** Adds sections to an entry already pushed. */
function appendSections(entry: WorkLogEntry, ...lists: WorkLogSection[][]) {
  const merged = withSections(entry.sections ?? [], ...lists);
  if (merged.sections) entry.sections = merged.sections;
  else delete entry.sections;
}
function fields(
  entries: ReadonlyArray<readonly [string, string | undefined]>,
): WorkLogField[] | undefined {
  const kept = entries
    .filter((entry): entry is readonly [string, string] => !!entry[1])
    .slice(0, 24)
    .map(([label, value]) => ({ label, value: cut(value, FIELD_CHARS) }));
  return kept.length > 0 ? kept : undefined;
}
function pairs(values: WorkLogField[] | undefined): Array<[string, string]> {
  return (values ?? []).map((field) => [field.label, field.value]);
}
