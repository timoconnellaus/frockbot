// Notes the platform adds to one request, at its tail.
//
// The system prompt and the tool list are the cached prefix, so what changes
// per Turn or per step goes after the conversation instead, labelled so the
// model reads it as the platform's. Several features may add one to the same
// request; they share one trailing message, because some providers refuse
// two user messages in a row.

import type { NormalizedModelRequest } from "./types.js";

export const RUNTIME_NOTE_LABEL_PREFIX_V1 = "[FrockBot runtime:";

/** The request with `note` at its tail, joined to a note already there. */
export function appendRuntimeNoteV1(
  request: NormalizedModelRequest,
  note: string,
): NormalizedModelRequest {
  const last = request.messages.at(-1);
  if (
    last?.role === "user" &&
    last.content.startsWith(RUNTIME_NOTE_LABEL_PREFIX_V1)
  ) {
    return {
      ...request,
      messages: [
        ...request.messages.slice(0, -1),
        { ...last, content: `${last.content}\n\n${note}` },
      ],
    };
  }
  return {
    ...request,
    messages: [...request.messages, { role: "user", content: note }],
  };
}
