import { describe, expect, test } from "bun:test";
import { APIError, APITimeoutError } from "@typesafe-ai/sdk";
import { base64ToBytesV1 } from "@frockbot/computer/egress";
import type { JevMeterV1 } from "../billing/jev.js";
import {
  createBrowserTaskDeciderV1,
  createJevEgressV1,
  JEV_EGRESS_BODY_MAX_BYTES_V1,
  JEV_EGRESS_QUESTIONS_MAX_V1,
} from "./jev-egress.js";
import { RESPONSE_REVIEW_MODEL_V1 } from "./response-review.js";

const bytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));

const QUESTION = {
  type: "choice",
  instructions: "Which?",
  criteria: { a: null, b: null },
};

function read(response: { status: number; bodyBase64: string }) {
  return {
    status: response.status,
    body: JSON.parse(
      new TextDecoder().decode(base64ToBytesV1(response.bodyBase64)),
    ) as Record<string, unknown>,
  };
}

function meter() {
  const log: string[] = [];
  const holds: number[] = [];
  const value: JevMeterV1 = {
    async reserve(request) {
      holds.push(request.maximumInputTokens);
      log.push(`reserve ${request.effectId}`);
      return {
        charge: async (tokens) => {
          log.push(`charge ${tokens}`);
        },
        release: async () => {
          log.push("release");
        },
      };
    },
  };
  return { value, log, holds };
}

function client(systemOne: (request: unknown) => Promise<unknown>) {
  return { systemOne } as never;
}

const ANSWERED = async (request: unknown) => {
  expect((request as { model: string }).model).toBe(RESPONSE_REVIEW_MODEL_V1);
  return {
    model: RESPONSE_REVIEW_MODEL_V1,
    answers: { pick: { type: "choice", choice: "a" } },
    usage: { input_tokens: 321, output_tokens: 0 },
  };
};

describe("Jev from the terminal", () => {
  test("answers on the platform's model and charges the tokens Jev counted", async () => {
    const billing = meter();
    const jev = createJevEgressV1({
      client: client(ANSWERED),
      meter: billing.value,
      botId: "bot-1",
      sessionId: "s-1",
    });
    const body = bytes({
      state: { page: "x" },
      questions: { pick: QUESTION },
      model: "some-other-model",
    });
    const answer = read(await jev({ body, effectId: "e:jev:0" }));
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      answers: { pick: { choice: "a" } },
      usage: { input_tokens: 321 },
    });
    expect(billing.log).toEqual(["reserve e:jev:0", "charge 321"]);
    expect(billing.holds[0]).toBeGreaterThanOrEqual(body.byteLength);
  });

  test("refuses a malformed, oversized or question-heavy body before charging", async () => {
    const billing = meter();
    let asked = false;
    const jev = createJevEgressV1({
      client: client(async () => {
        asked = true;
        return {};
      }),
      meter: billing.value,
      botId: "bot-1",
      sessionId: "s-1",
    });
    const cases = [
      new TextEncoder().encode("not json"),
      bytes({ state: {}, questions: {} }),
      bytes({ state: "x", questions: { pick: QUESTION } }),
      bytes({
        state: {},
        questions: Object.fromEntries(
          Array.from({ length: JEV_EGRESS_QUESTIONS_MAX_V1 + 1 }, (_, i) => [
            `q${i}`,
            QUESTION,
          ]),
        ),
      }),
    ];
    for (const body of cases) {
      expect((await jev({ body, effectId: "e" })).status).toBe(400);
    }
    const huge = new Uint8Array(JEV_EGRESS_BODY_MAX_BYTES_V1 + 1);
    expect((await jev({ body: huge, effectId: "e" })).status).toBe(413);
    expect(asked).toBe(false);
    expect(billing.log).toEqual([]);
  });

  test("an account that cannot pay is refused and Jev is never asked", async () => {
    let asked = false;
    const jev = createJevEgressV1({
      client: client(async () => {
        asked = true;
        return {};
      }),
      meter: {
        reserve: async () => {
          throw new Error("You are out of credit.");
        },
      },
      botId: "bot-1",
      sessionId: "s-1",
    });
    const answer = read(
      await jev({
        body: bytes({ state: {}, questions: { pick: QUESTION } }),
        effectId: "e",
      }),
    );
    expect(answer).toEqual({
      status: 402,
      body: { message: "You are out of credit." },
    });
    expect(asked).toBe(false);
  });

  test("a refusal Jev answered is released; an unknown outcome stays held", async () => {
    const refused = meter();
    const bad = createJevEgressV1({
      client: client(async () => {
        throw new APIError(422, { error: "bad question" }, new Headers());
      }),
      meter: refused.value,
      botId: "bot-1",
      sessionId: "s-1",
    });
    const body = bytes({ state: {}, questions: { pick: QUESTION } });
    expect((await bad({ body, effectId: "e" })).status).toBe(400);
    expect(refused.log).toEqual(["reserve e", "release"]);

    const unknown = meter();
    const slow = createJevEgressV1({
      client: client(async () => {
        throw new APITimeoutError(10_000);
      }),
      meter: unknown.value,
      botId: "bot-1",
      sessionId: "s-1",
    });
    expect((await slow({ body, effectId: "e" })).status).toBe(502);
    expect(unknown.log).toEqual(["reserve e"]);
  });

  test("with billing off it answers and charges nothing", async () => {
    const jev = createJevEgressV1({
      client: client(ANSWERED),
      botId: "bot-1",
      sessionId: "s-1",
    });
    const answer = await jev({
      body: bytes({ state: {}, questions: { pick: QUESTION } }),
      effectId: "e",
    });
    expect(answer.status).toBe(200);
  });
});

describe("Jev for a browser task", () => {
  test("answers on the platform's model and charges the tokens Jev counted", async () => {
    const billing = meter();
    const decide = createBrowserTaskDeciderV1({
      client: client(ANSWERED),
      meter: billing.value,
      botId: "bot-1",
      sessionId: "s-1",
    });
    const answers = await decide(
      { state: { goal: "x" }, questions: { pick: QUESTION } },
      "tool:1:1:0:jev:0",
    );
    expect(answers).toMatchObject({ pick: { choice: "a" } });
    expect(billing.log).toEqual(["reserve tool:1:1:0:jev:0", "charge 321"]);
  });

  test("an account that cannot pay, or a Jev that does not answer, ends the task", async () => {
    const broke = createBrowserTaskDeciderV1({
      client: client(ANSWERED),
      meter: {
        reserve: async () => {
          throw new Error("out of credit");
        },
      },
      botId: "bot-1",
      sessionId: "s-1",
    });
    expect(
      await broke({ state: {}, questions: { pick: QUESTION } }, "e"),
    ).toBeUndefined();
    const refused = meter();
    const bad = createBrowserTaskDeciderV1({
      client: client(async () => {
        throw new APIError(422, {}, new Headers());
      }),
      meter: refused.value,
      botId: "bot-1",
      sessionId: "s-1",
    });
    expect(
      await bad({ state: {}, questions: { pick: QUESTION } }, "e"),
    ).toBeUndefined();
    expect(refused.log).toEqual(["reserve e", "release"]);
  });
});
