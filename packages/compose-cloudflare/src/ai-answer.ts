/**
 * The text of a Workers AI answer. Older models answer `{ response }`; the
 * OpenAI-shaped ones answer `{ choices: [{ message: { content } }] }`.
 */
export function aiAnswerText(answer: unknown): string | undefined {
  const value = answer as {
    response?: unknown;
    choices?: Array<{ message?: { content?: unknown } }>;
  } | null;
  if (typeof value?.response === "string") return value.response;
  const content = value?.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : undefined;
}
