import { APIError, TypeSafeError } from "@typesafe-ai/sdk";

/** Keeps status and request ID without carrying headers into a report. */
export function describeFailureV1(error: unknown) {
  if (error instanceof APIError)
    return {
      kind: error.constructor.name,
      message: error.message,
      status: error.status,
      requestId: error.requestId ?? null,
    };
  if (error instanceof TypeSafeError)
    return { kind: error.constructor.name, message: error.message };
  return { kind: "Error", message: String(error) };
}
