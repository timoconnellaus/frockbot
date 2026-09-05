import type { WorkersAiBinding } from "../../src/index";

const encoder = new TextEncoder();

/** One server-sent event, framed the way Workers AI frames them. */
export const frame = (payload: unknown): string =>
  `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`;

/** The frames of a whole answer in the native Workers AI shape. */
export const nativeAnswer = (
  text: ReadonlyArray<string>,
  toolCalls?: ReadonlyArray<{ name: string; arguments: unknown }>,
): Array<string> => [
  ...text.map((each) => frame({ response: each })),
  ...(toolCalls ? [frame({ response: "", tool_calls: toolCalls })] : []),
  frame("[DONE]"),
];

/** The frames of a whole answer in the chat-completions shape. */
export const chatAnswer = (text: ReadonlyArray<string>): Array<string> => [
  ...text.map((each) =>
    frame({ choices: [{ index: 0, delta: { content: each } }] }),
  ),
  frame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
  frame("[DONE]"),
];

/** One scripted answer from the binding. */
export interface AiAnswer {
  frames: ReadonlyArray<string>;
  /** Leave the stream open after the frames, so only a cancellation ends it. */
  hold?: boolean;
}

/** What one call to the binding looked like. */
export interface AiCall {
  model: string;
  inputs: Record<string, any>;
  options: Record<string, any> | undefined;
}

/**
 * A Workers AI binding that answers from a script. The frames are enqueued in
 * small slices, so anything reading them has to cope with an event split across
 * two reads, and a cancelled body is counted — which is how a test sees that a
 * cancelled turn really stopped the model rather than just stopped listening.
 */
export const fakeAi = (
  script: ReadonlyArray<AiAnswer>,
): {
  binding: WorkersAiBinding;
  calls: Array<AiCall>;
  cancelled: () => number;
} => {
  const calls: Array<AiCall> = [];
  let cancelled = 0;
  let index = 0;

  return {
    calls,
    cancelled: () => cancelled,
    binding: {
      run: (model, inputs, options) => {
        calls.push({ model, inputs, options });
        const answer = script[index];
        index += 1;
        if (!answer) {
          return Promise.reject(
            new Error(`the fake binding has no answer for call ${index}`),
          );
        }
        const body = answer.frames.join("");
        return Promise.resolve(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (let at = 0; at < body.length; at += 11) {
                controller.enqueue(encoder.encode(body.slice(at, at + 11)));
              }
              if (!answer.hold) controller.close();
            },
            cancel() {
              cancelled += 1;
            },
          }),
        );
      },
    },
  };
};
