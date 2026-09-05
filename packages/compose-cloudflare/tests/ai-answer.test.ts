import { describe, expect, it } from "bun:test";
import { aiAnswerText } from "../src/ai-answer";

describe("the text of a Workers AI answer", () => {
  it("reads the classic response field", () => {
    expect(aiAnswerText({ response: "hello" })).toBe("hello");
  });

  it("reads an OpenAI-shaped answer, as glm-5.3-flash returns", () => {
    expect(
      aiAnswerText({
        choices: [
          {
            finish_reason: "stop",
            index: 0,
            message: { content: "hello", reasoning_content: "thinking" },
          },
        ],
      }),
    ).toBe("hello");
  });

  it("is undefined when neither carries a string", () => {
    expect(aiAnswerText({ response: 42 })).toBeUndefined();
    expect(aiAnswerText({ choices: [] })).toBeUndefined();
    expect(aiAnswerText(null)).toBeUndefined();
  });
});
