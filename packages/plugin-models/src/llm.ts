import { type Context, Service } from "cordis";
import {
  LlmEffectNotStartedError,
  type LlmProvider,
  type LlmReconciliationOutcome,
  type LlmStreamEvent,
  type ModelInvocation,
  type NormalizedModelRequest,
  type JsonSchemaResponseFormatV1,
  type StructuredModelResultV1,
  validateStructuredOutputV1,
} from "@frockbot/kernel-contracts";

export class LlmRegistry extends Service implements ModelInvocation {
  private providers = new Map<string, LlmProvider>();

  constructor(ctx: Context) {
    super(ctx, "llm");
  }

  register(provider: LlmProvider): () => void {
    if (this.providers.has(provider.id)) {
      throw new Error(`LLM provider "${provider.id}" is already registered`);
    }
    this.providers.set(provider.id, provider);
    return () => {
      if (this.providers.get(provider.id) === provider) {
        this.providers.delete(provider.id);
      }
    };
  }

  get(providerId: string): LlmProvider | undefined {
    return this.providers.get(providerId);
  }

  list(): LlmProvider[] {
    return [...this.providers.values()];
  }

  stream(
    request: NormalizedModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<LlmStreamEvent> {
    const provider = this.providers.get(request.provider);
    if (!provider)
      throw new LlmEffectNotStartedError(
        `LLM provider "${request.provider}" is unavailable`,
      );
    const events = this.ctx.waterfall("llm/stream", request, signal, () =>
      provider.stream(request, signal),
    );
    return this.validatedStream(request, events);
  }

  private async *validatedStream(
    request: NormalizedModelRequest,
    events: AsyncIterable<LlmStreamEvent>,
  ): AsyncIterable<LlmStreamEvent> {
    let text = "";
    let sawStructuredFailure = false;
    let validatedStructuredOutput = false;
    for await (const event of events) {
      if (event.type === "text-delta") text += event.text;
      if (event.type === "structured-output-failure") {
        sawStructuredFailure = true;
      }
      if (
        event.type === "finish" &&
        request.responseFormat?.type === "json_schema" &&
        !sawStructuredFailure
      ) {
        validatedStructuredOutput = true;
        const result = validateStructuredOutputV1(
          text,
          request.responseFormat.schema,
        );
        if (result.status === "failed") {
          yield { type: "structured-output-failure", failure: result.failure };
        }
      }
      yield event;
    }
    if (
      request.responseFormat?.type === "json_schema" &&
      !sawStructuredFailure &&
      !validatedStructuredOutput
    ) {
      const result = validateStructuredOutputV1(
        text,
        request.responseFormat.schema,
      );
      if (result.status === "failed") {
        yield { type: "structured-output-failure", failure: result.failure };
      }
    }
  }

  async structured<T>(
    request: NormalizedModelRequest,
    format: Omit<JsonSchemaResponseFormatV1, "type">,
    signal: AbortSignal,
  ): Promise<StructuredModelResultV1<T>> {
    const structuredRequest: NormalizedModelRequest = {
      ...request,
      responseFormat: { type: "json_schema", ...format },
    };
    let raw = "";
    let failure:
      | Extract<
          Awaited<ReturnType<typeof validateStructuredOutputV1>>,
          { status: "failed" }
        >["failure"]
      | undefined;
    for await (const event of this.stream(structuredRequest, signal)) {
      if (event.type === "text-delta") raw += event.text;
      if (event.type === "structured-output-failure") {
        failure = event.failure;
      }
    }
    if (failure) return { status: "failed", failure, raw };
    const validated = validateStructuredOutputV1(raw, format.schema);
    if (validated.status === "failed") return validated;
    // SAFETY: callers choose T alongside the schema that was just validated.
    return { status: "completed", value: validated.value as T, raw };
  }

  async reconcile(
    request: NormalizedModelRequest,
    signal: AbortSignal,
  ): Promise<LlmReconciliationOutcome> {
    const provider = this.providers.get(request.provider);
    if (!provider) {
      return {
        status: "unavailable",
        reason: `LLM provider "${request.provider}" is unavailable`,
      };
    }
    if (!provider.reconciliation) {
      // A provider that declares no retrieval will never grow one mid-run, so
      // parking the run on it would wedge the Bot permanently. Settle instead.
      return {
        status: "not-retrievable",
        reason: `LLM provider "${request.provider}" does not support provider-bound retrieval`,
      };
    }
    try {
      const outcome = await provider.reconciliation.retrieve(
        { providerEffectId: request.requestId, request },
        signal,
      );
      if (
        outcome.status !== "recovered" ||
        request.responseFormat?.type !== "json_schema"
      ) {
        return outcome;
      }
      const raw = outcome.events
        .filter(
          (event): event is Extract<LlmStreamEvent, { type: "text-delta" }> =>
            event.type === "text-delta",
        )
        .map((event) => event.text)
        .join("");
      const validated = validateStructuredOutputV1(
        raw,
        request.responseFormat.schema,
      );
      if (validated.status === "completed") return outcome;
      const finish = outcome.events.findIndex(
        (event) => event.type === "finish",
      );
      const events = [...outcome.events];
      events.splice(finish < 0 ? events.length : finish, 0, {
        type: "structured-output-failure",
        failure: validated.failure,
      });
      return { status: "recovered", events };
    } catch (error) {
      signal.throwIfAborted();
      return {
        status: "unavailable",
        reason:
          error instanceof Error
            ? error.message
            : "Provider-bound retrieval failed",
      };
    }
  }
}
