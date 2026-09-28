// Who wrote each part of a Turn's input.
//
// A Turn's input is one message to the model, but it is often assembled from
// several writers: a Routine's hand-off drained in front of what the person
// typed, a card press, a Routine's own prompt and the payload a webhook
// delivered with it. The model reads them as one message. Supervision must not:
// only the person speaks for the person, so every part keeps its writer from
// the moment it is admitted.
import { exactKeysV1, recordV1 } from "./records.js";

/**
 * - `person`: what the User typed or said to this Bot.
 * - `routine`: the prompt of a Routine the User wrote, run as their standing
 *   request; a prompt a Bot wrote or last changed is `bot`.
 * - `bot`: words a Bot wrote — a hand-off, a brief, another Bot's message.
 * - `plugin`: text a Plugin produced, such as a card's context.
 * - `platform`: FrockBot's own notices — an approval's decision, a steering
 *   marker, a delivery cue.
 * - `external`: content from outside — a webhook payload, a group member, a
 *   machine's output.
 */
export const INPUT_AUTHORS_V1 = [
  "person",
  "routine",
  "bot",
  "plugin",
  "platform",
  "external",
] as const;

export type InputAuthorV1 = (typeof INPUT_AUTHORS_V1)[number];

/** One part of an input, in the order the model reads them. */
export interface InputSegmentV1 {
  author: InputAuthorV1;
  text: string;
}

/** Most parts one input is assembled from. */
export const INPUT_SEGMENT_LIMIT_V1 = 64;

export function decodeInputSegmentsV1(
  value: unknown,
  label: string,
): InputSegmentV1[] {
  if (!Array.isArray(value) || value.length > INPUT_SEGMENT_LIMIT_V1) {
    throw new Error(
      `${label} must be an array of at most ${INPUT_SEGMENT_LIMIT_V1}`,
    );
  }
  return value.map((entry, index) => {
    const itemLabel = `${label}[${index}]`;
    const item = recordV1(entry, itemLabel);
    exactKeysV1(item, ["author", "text"], [], itemLabel);
    if (!INPUT_AUTHORS_V1.includes(item.author as InputAuthorV1)) {
      throw new Error(`${itemLabel}.author is not a known author`);
    }
    if (typeof item.text !== "string") {
      throw new Error(`${itemLabel}.text must be a string`);
    }
    return { author: item.author as InputAuthorV1, text: item.text };
  });
}

/** The input as the model reads it: its parts, one after another. */
export function inputSegmentsTextV1(
  segments: readonly InputSegmentV1[],
): string {
  return segments.map((segment) => segment.text).join("\n");
}
