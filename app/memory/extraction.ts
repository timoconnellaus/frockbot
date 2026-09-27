import type {
  LlmStreamEvent,
  ModelBindingSnapshot,
  NormalizedModelRequest,
  StructuredOutputSchemaV1,
} from "@frockbot/core/contracts";
import type { MemoryExtractionDispatchV1 } from "./processing.js";
import type { MemoryExtractedProposalV1 } from "./records.js";

// What a Turn's own words hold that is worth remembering, pulled out after the
// Turn by the platform's summary model. The call is paid model work like a
// summary: billed to the Turn that captured the words, dispatched once under
// the job's own id, and never repeated when its outcome is unknown. What it
// proposes is written through the engine, which refuses secrets, drops
// repeats and honours what the person asked to forget.

/** Recorded in the request id, so a dispatched call names the prompt it ran. */
export const MEMORY_EXTRACTION_PROMPT_VERSION_V1 = "extract-1";

/** The request id prefix every extraction call carries. */
export const MEMORY_EXTRACTION_EFFECT_PREFIX_V1 = "memory-extract-";

/** The most facts one Turn's words yield. */
export const MEMORY_EXTRACTION_MAX_FACTS_V1 = 8;

const MEMORY_EXTRACTION_FACT_CHARS_V1 = 300;

export const MEMORY_EXTRACTION_SYSTEM_PROMPT_V1 = [
  "You read what a person said to their assistant and pick out what the assistant should remember about them for later conversations.",
  "",
  "Keep only:",
  "- lasting facts about the person: who they are, the people and places in their life, how they like things done, what they want or avoid;",
  "- events worth recalling later: something that happened to them or that they decided, with its date when they gave one.",
  "",
  "Leave out: requests for the assistant to do something now, questions, small talk, anything about the assistant itself, and anything you would have to guess.",
  "Never include a password, code, key, card or account number, or any other secret, even if they said it.",
  "",
  'Write each as one short sentence in the third person, naming the person as they named themselves, or as "The person".',
  "Return nothing when nothing is worth remembering.",
].join("\n");

export const MEMORY_EXTRACTION_SCHEMA_V1: StructuredOutputSchemaV1 = {
  type: "object",
  properties: {
    memories: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          kind: { type: "string", enum: ["fact", "experience"] },
        },
        required: ["text", "kind"],
        additionalProperties: false,
      },
    },
  },
  required: ["memories"],
  additionalProperties: false,
};

export function memoryExtractionRequestV1(input: {
  readonly dispatch: MemoryExtractionDispatchV1;
  readonly provider: string;
  readonly model: string;
  readonly modelBinding?: ModelBindingSnapshot;
}): NormalizedModelRequest {
  return {
    requestId: `${MEMORY_EXTRACTION_EFFECT_PREFIX_V1}${MEMORY_EXTRACTION_PROMPT_VERSION_V1}-${input.dispatch.obligationId}`,
    provider: input.provider,
    model: input.model,
    system: MEMORY_EXTRACTION_SYSTEM_PROMPT_V1,
    messages: [
      {
        role: "user",
        content: `--- what the person said ---\n${input.dispatch.capturedText}\n--- end ---`,
      },
    ],
    tools: [],
    responseFormat: {
      type: "json_schema",
      name: "memories",
      schema: MEMORY_EXTRACTION_SCHEMA_V1,
    },
    ...(input.modelBinding ? { modelBinding: input.modelBinding } : {}),
  };
}

/** The proposals in the model's answer; anything malformed is left out. */
export function parseMemoryExtractionV1(
  text: string,
): MemoryExtractedProposalV1[] {
  let parsed: unknown;
  try {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    parsed = JSON.parse(
      start >= 0 && end > start ? text.slice(start, end + 1) : text,
    );
  } catch {
    throw new Error("The memory extraction answer was not JSON.");
  }
  const memories =
    typeof parsed === "object" && parsed !== null && "memories" in parsed
      ? (parsed as { memories: unknown }).memories
      : undefined;
  if (!Array.isArray(memories)) {
    throw new Error("The memory extraction answer had no memories list.");
  }
  const seen = new Set<string>();
  const proposals: MemoryExtractedProposalV1[] = [];
  for (const memory of memories) {
    if (proposals.length >= MEMORY_EXTRACTION_MAX_FACTS_V1) break;
    if (typeof memory !== "object" || memory === null) continue;
    const { text: raw, kind } = memory as { text?: unknown; kind?: unknown };
    if (typeof raw !== "string") continue;
    const fact = raw.trim();
    if (fact.length === 0 || fact.length > MEMORY_EXTRACTION_FACT_CHARS_V1) {
      continue;
    }
    const key = fact.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    proposals.push({
      text: fact,
      kind: kind === "experience" ? "experience" : "fact",
    });
  }
  return proposals;
}

/**
 * An extractor over a model stream. A stream that fails throws, and the drain
 * then blocks the job rather than asking twice.
 */
export function createModelMemoryExtractorV1(deps: {
  readonly provider: string;
  readonly model: string;
  readonly modelBinding?: ModelBindingSnapshot;
  stream(
    request: NormalizedModelRequest,
    dispatch: MemoryExtractionDispatchV1,
    signal: AbortSignal,
  ): AsyncIterable<LlmStreamEvent>;
  /** The whole call's bound; the drain runs in the background. */
  readonly timeoutMs?: number;
}): (
  dispatch: MemoryExtractionDispatchV1,
) => Promise<readonly MemoryExtractedProposalV1[]> {
  return async (dispatch) => {
    const request = memoryExtractionRequestV1({
      dispatch,
      provider: deps.provider,
      model: deps.model,
      ...(deps.modelBinding ? { modelBinding: deps.modelBinding } : {}),
    });
    // A cleared timer rather than `AbortSignal.timeout`, whose pending timer
    // would hold the Bot's object in memory after the call is done.
    const controller = new AbortController();
    const deadline = setTimeout(
      () =>
        controller.abort(new Error("Memory extraction ran past its deadline.")),
      deps.timeoutMs ?? 60_000,
    );
    let text = "";
    try {
      for await (const event of deps.stream(
        request,
        dispatch,
        controller.signal,
      )) {
        if (event.type === "text-delta") text += event.text;
      }
    } finally {
      clearTimeout(deadline);
    }
    return parseMemoryExtractionV1(text);
  };
}
