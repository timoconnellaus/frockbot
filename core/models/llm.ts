import {
  LlmEffectNotStartedError,
  type LoopHookListV1,
  type LlmProvider,
  type LlmStreamEvent,
  type ModelAttachmentResolverV1,
  type ModelInvocation,
  type NormalizedModelRequest,
  type JsonSchemaResponseFormatV1,
  parseStructuredOutputJsonV1,
  type StructuredModelResultV1,
  validateStructuredOutputV1,
} from "@frockbot/core/contracts";

export class LlmRegistry implements ModelInvocation {
  private providers = new Map<string, LlmProvider>();

  constructor(
    private readonly hooks: LoopHookListV1,
    private readonly attachments?: ModelAttachmentResolverV1,
  ) {}

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
    const resolver = this.attachments;
    const events = resolver
      ? this.resolvedStream(resolver, provider, request, signal)
      : this.hooks.modelStream(request, signal, () =>
          provider.stream(request, signal),
        );
    return this.validatedStream(request, events);
  }

  /**
   * The provider sees the request with its attachments filled in; the loop
   * journaled it without them, and still holds that one.
   */
  private async *resolvedStream(
    resolver: ModelAttachmentResolverV1,
    provider: LlmProvider,
    request: NormalizedModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<LlmStreamEvent> {
    let resolved: NormalizedModelRequest;
    try {
      resolved = await resolver.resolve(request, signal);
    } catch (error) {
      signal.throwIfAborted();
      // Nothing was sent: a read that failed before the provider was asked
      // is a call that never started, and saying so keeps the Turn out of
      // an uncertain outcome it would otherwise park on.
      throw new LlmEffectNotStartedError(
        `The files attached to this conversation could not be read: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    yield* this.hooks.modelStream(resolved, signal, () =>
      provider.stream(resolved, signal),
    );
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
