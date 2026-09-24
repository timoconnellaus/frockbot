import { describe, expect, test } from "bun:test";
import { telegramApiV1 } from "./api.js";

const TOKEN = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";

function answering(
  answer: () => Response | Promise<Response>,
  calls: Array<{ url: string; body: unknown }> = [],
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    return answer();
  }) as typeof fetch;
}

describe("the Bot API", () => {
  test("a message Telegram accepted was sent", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const api = telegramApiV1(
      TOKEN,
      answering(() => Response.json({ ok: true, result: {} }), calls),
    );
    expect(await api.sendMessage("42", "Hello")).toEqual({ status: "sent" });
    expect(calls).toEqual([
      {
        url: `https://api.telegram.org/bot${TOKEN}/sendMessage`,
        body: {
          chat_id: "42",
          text: "Hello",
          link_preview_options: { is_disabled: true },
        },
      },
    ]);
  });

  test("too many requests waits as long as Telegram says", async () => {
    const api = telegramApiV1(
      TOKEN,
      answering(() =>
        Response.json(
          { ok: false, error_code: 429, parameters: { retry_after: 7 } },
          { status: 429 },
        ),
      ),
    );
    expect(await api.sendMessage("42", "Hello")).toEqual({
      status: "retry",
      retryAfterMs: 7_000,
    });
  });

  test("a refusal was not shown; an unclear answer may have been", async () => {
    const blocked = telegramApiV1(
      TOKEN,
      answering(() =>
        Response.json(
          { ok: false, description: "Forbidden: bot was blocked by the user" },
          { status: 403 },
        ),
      ),
    );
    expect(await blocked.sendMessage("42", "Hello")).toEqual({
      status: "rejected",
      description: "Forbidden: bot was blocked by the user",
    });
    const broken = telegramApiV1(
      TOKEN,
      answering(() => new Response("bad gateway", { status: 502 })),
    );
    expect(await broken.sendMessage("42", "Hello")).toEqual({
      status: "uncertain",
    });
    const lost = telegramApiV1(
      TOKEN,
      answering(() => Promise.reject(new TypeError("connection reset"))),
    );
    expect(await lost.sendMessage("42", "Hello")).toEqual({
      status: "uncertain",
    });
  });

  test("a failed setup call never names the token", async () => {
    const api = telegramApiV1(
      TOKEN,
      answering(() =>
        Response.json(
          { ok: false, description: "Unauthorized" },
          { status: 401 },
        ),
      ),
    );
    const failure = await api
      .setWebhook("https://x.test/hook", "s".repeat(40))
      .then(() => undefined)
      .catch((error: unknown) => error as Error);
    expect(failure?.message).toContain("Unauthorized");
    expect(failure?.message).not.toContain(TOKEN);
    expect(failure?.message).not.toContain("ABCDEFGHIJ");
  });
});
