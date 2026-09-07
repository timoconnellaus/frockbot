import {
  LlmEffectNotStartedError,
  type LoopHookListV1,
  type LlmProvider,
  type LlmStreamEvent,
  type ModelInvocation,
  type NormalizedModelRequest,
  type JsonSchemaResponseFormatV1,
  parseStructuredOutputJsonV1,
  type StructuredModelResultV1,
  validateStructuredOutputV1,
} from "@frockbot/kernel-contracts";

export class LlmRegistry implements ModelInvocation {
  private providers = new Map<string, LlmProvider>();

  constructor(private readonly hooks: LoopHookListV1) {}

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
    const events = this.hooks.modelStream(request, signal, () =>
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
    let validatedResponseFormat = false;
    for await (const event of events) {
      if (event.type === "text-delta") text += event.text;
      if (event.type === "structured-output-failure") {
        sawStructuredFailure = true;
      }
      if (
        event.type === "finish" &&
        request.responseFormat &&
        !sawStructuredFailure
      ) {
        validatedResponseFormat = true;
        const failure = responseFormatFailureV1(request, text);
        if (failure) yield { type: "structured-output-failure", failure };
      }
      yield event;
    }
    if (
      request.responseFormat &&
      !sawStructuredFailure &&
      !validatedResponseFormat
    ) {
      const failure = responseFormatFailureV1(request, text);
      if (failure) yield { type: "structured-output-failure", failure };
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
}

function responseFormatFailureV1(
  request: NormalizedModelRequest,
  text: string,
):
  | Extract<StructuredModelResultV1<unknown>, { status: "failed" }>["failure"]
  | undefined {
  const format = request.responseFormat;
  if (!format) return undefined;
  const result =
    format.type === "json_schema"
      ? validateStructuredOutputV1(text, format.schema)
      : parseStructuredOutputJsonV1(text);
  return result.status === "failed" ? result.failure : undefined;
}
