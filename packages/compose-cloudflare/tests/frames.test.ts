import { describe, expect, it } from "bun:test";
import { aiFrames, textOf } from "../src/frames";

const sse = (text: string): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });

describe("the text of a Workers AI frame", () => {
  it("reads a chat delta once when the native response repeats it", () => {
    expect(
      textOf({ response: "alpha", choices: [{ delta: { content: "alpha" } }] }),
    ).toBe("alpha");
  });

  it("reads the native response when there is no chat part", () => {
    expect(textOf({ response: "alpha" })).toBe("alpha");
  });

  it("reads nothing from a reasoning-only delta", () => {
    expect(
      textOf({ choices: [{ delta: { reasoning_content: "hmm" } as never }] }),
    ).toBe("");
  });
});

describe("the frames of a server-sent-event body", () => {
  it("splits events on CRLF as well as LF", async () => {
    const out: Array<string> = [];
    for await (const frame of aiFrames(
      sse(
        'data: {"choices":[{"delta":{"content":"a"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"b"}}]}\n\ndata: [DONE]\r\n\r\n',
      ),
    )) {
      out.push(textOf(frame));
    }
    expect(out).toEqual(["a", "b"]);
  });
});
