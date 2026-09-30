import { describe, expect, test } from "bun:test";

import type {
  MachineRelayFrameV1,
  MachineRelayUpFrameV1,
} from "@frockbot/core/machine-protocol";

import { LocalModelRelayV1, relayPiecesV1 } from "./relay.ts";

const NOW = new Date().toISOString();
const LATER = new Date(Date.now() + 60_000).toISOString();

function frame(
  overrides: Partial<MachineRelayFrameV1> = {},
): MachineRelayFrameV1 {
  return {
    type: "relay",
    relayId: "chat:req-1",
    method: "POST",
    url: "http://localhost:11434/v1/chat/completions",
    body: '{"model":"llama3"}',
    deadline: LATER,
    serverTime: NOW,
    ...overrides,
  };
}

function harness(
  answer: (url: string, init: RequestInit) => Promise<Response> = async () =>
    new Response("data: hello\n\n", {
      headers: { "content-type": "text/event-stream" },
    }),
) {
  const fetched: { url: string; init: RequestInit }[] = [];
  const sent: MachineRelayUpFrameV1[] = [];
  const relay = new LocalModelRelayV1({
    fetch: (url, init) => {
      fetched.push({ url, init });
      return answer(url, init);
    },
  });
  return {
    relay,
    fetched,
    sent,
    send: (reply: MachineRelayUpFrameV1) => sent.push(reply),
  };
}

describe("the localhost-only rule", () => {
  test.each([
    "https://api.openai.com/v1/chat/completions",
    "http://192.168.1.20:11434/v1/chat/completions",
    "http://169.254.169.254/latest/meta-data",
    "http://localhost.evil.com:11434/v1",
    "http://user:pw@localhost:11434/v1",
  ])("refuses %s without fetching it", async (url) => {
    const { relay, fetched, sent, send } = harness();
    await relay.handle(frame({ url }), send);
    expect(fetched).toHaveLength(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.type).toBe("relay-fail");
    expect((sent[0] as { error: string }).error).toStartWith("refused:");
  });

  test.each([
    "http://localhost:11434/v1/models",
    "http://127.0.0.1:1234/v1/models",
    "http://[::1]:9337/v1/models",
  ])("forwards %s", async (url) => {
    const { relay, fetched, send } = harness();
    await relay.handle(frame({ url, method: "GET", body: null }), send);
    expect(fetched.map((call) => call.url)).toEqual([url]);
  });

  test("a redirect is refused rather than followed", async () => {
    const { relay, fetched, send } = harness();
    await relay.handle(frame(), send);
    expect(fetched[0]!.init.redirect).toBe("error");
  });
});

describe("relaying", () => {
  test("streams the head, the data and the end", async () => {
    const { relay, fetched, sent, send } = harness();
    await relay.handle(frame(), send);
    expect(fetched[0]!.init.method).toBe("POST");
    expect(fetched[0]!.init.body).toBe('{"model":"llama3"}');
    expect(sent).toEqual([
      {
        type: "relay-head",
        relayId: "chat:req-1",
        status: 200,
        contentType: "text/event-stream",
      },
      { type: "relay-data", relayId: "chat:req-1", data: "data: hello\n\n" },
      { type: "relay-end", relayId: "chat:req-1" },
    ]);
  });

  test("a server that is not running is a clear failure", async () => {
    const { relay, sent, send } = harness(async () => {
      throw new TypeError(
        "error sending request: Connection refused (os error 61)",
      );
    });
    await relay.handle(frame(), send);
    expect(sent).toEqual([
      {
        type: "relay-fail",
        relayId: "chat:req-1",
        error:
          "Nothing is answering at localhost:11434 on this Mac. Start the model server and try again.",
      },
    ]);
  });

  test("a frame delivered twice is forwarded once", async () => {
    const { relay, fetched, send } = harness();
    await relay.handle(frame(), send);
    await relay.handle(frame(), send);
    expect(fetched).toHaveLength(1);
  });

  test("a cancel stops the request", async () => {
    let seen: AbortSignal | undefined;
    const { relay, sent, send } = harness(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          seen = init.signal ?? undefined;
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const running = relay.handle(frame(), send);
    await Promise.resolve();
    await relay.handle({ type: "relay-cancel", relayId: "chat:req-1" }, send);
    await running;
    expect(seen?.aborted).toBe(true);
    expect(sent.every((reply) => reply.type === "relay-fail")).toBe(true);
  });

  test("a request past its deadline is not sent", async () => {
    const { relay, fetched, sent, send } = harness();
    await relay.handle(frame({ deadline: NOW, serverTime: NOW }), send);
    expect(fetched).toHaveLength(0);
    expect(sent[0]!.type).toBe("relay-fail");
  });

  test("too many at once are refused", async () => {
    const pending: (() => void)[] = [];
    const { relay, sent, send } = harness(
      () =>
        new Promise((resolve) => {
          pending.push(() => resolve(new Response("")));
        }),
    );
    const runs = [1, 2, 3, 4].map((n) =>
      relay.handle(frame({ relayId: `r${n}` }), send),
    );
    await relay.handle(frame({ relayId: "r5" }), send);
    expect(sent).toEqual([
      expect.objectContaining({ type: "relay-fail", relayId: "r5" }),
    ]);
    for (const release of pending) release();
    await Promise.all(runs);
  });
});

describe("relayPiecesV1", () => {
  test("never cuts a surrogate pair", () => {
    const text = `ab${"😀"}cd`;
    const pieces = relayPiecesV1(text, 3);
    expect(pieces.join("")).toBe(text);
    for (const piece of pieces) {
      const last = piece.charCodeAt(piece.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
  });
});
