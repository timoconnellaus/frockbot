import { describe, expect, test } from "bun:test";
import { ComputerError } from "@frockbot/computer-core";
import {
  COMPUTER_HOST_ROUTES,
  COMPUTER_HOST_STREAM_MEDIA_TYPE,
  COMPUTER_HOST_TOKEN_HEADER,
  computerHostProblemV1,
  encodeComputerHostExecFrameV1,
  encodeComputerHostOpenFrameV1,
  type ComputerHostExecFrameV1,
  type ComputerHostOpenFrameV1,
  type ComputerHostProvisioningV1,
} from "@frockbot/computer-host-protocol";
import {
  ComputerHostClient,
  type ComputerHostFetcherV1,
} from "./host-client.ts";

interface RecordedCall {
  pathname: string;
  token: string | null;
  body: Record<string, unknown>;
}

function base64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** A fetcher that records what it was asked and answers from a queue. */
function recorder(
  answer: (call: RecordedCall) => Response | Promise<Response>,
): { fetcher: ComputerHostFetcherV1; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    fetcher: {
      async fetch(request: Request): Promise<Response> {
        const call: RecordedCall = {
          pathname: new URL(request.url).pathname,
          token: request.headers.get(COMPUTER_HOST_TOKEN_HEADER),
          body: (await request.json()) as Record<string, unknown>,
        };
        calls.push(call);
        return answer(call);
      },
    },
  };
}

/** Never answers; rejects the way `fetch` does when its signal aborts. */
function hanging(calls: RecordedCall[] = []): ComputerHostFetcherV1 {
  return {
    async fetch(request: Request): Promise<Response> {
      calls.push({
        pathname: new URL(request.url).pathname,
        token: request.headers.get(COMPUTER_HOST_TOKEN_HEADER),
        body: (await request.json()) as Record<string, unknown>,
      });
      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener(
          "abort",
          () => reject(new Error("aborted by signal")),
          { once: true },
        );
      });
    },
  };
}

/**
 * An NDJSON body whose chunk boundaries are deliberately wrong: every chunk is
 * `size` bytes regardless of where a frame ends. A client that reads a chunk
 * as a frame fails here and only here.
 */
function ndjson(
  frames: readonly ComputerHostExecFrameV1[],
  size: number,
): Response {
  const bytes = new TextEncoder().encode(
    frames.map(encodeComputerHostExecFrameV1).join(""),
  );
  let offset = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.byteLength) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.subarray(offset, offset + size));
        offset += size;
      },
    }),
    { headers: { "content-type": COMPUTER_HOST_STREAM_MEDIA_TYPE } },
  );
}

function openNdjson(
  frames: readonly ComputerHostOpenFrameV1[],
  size: number,
): Response {
  const bytes = new TextEncoder().encode(
    frames.map(encodeComputerHostOpenFrameV1).join(""),
  );
  let offset = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.byteLength) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.subarray(offset, offset + size));
        offset += size;
      },
    }),
    { headers: { "content-type": COMPUTER_HOST_STREAM_MEDIA_TYPE } },
  );
}

function client(
  fetcher: ComputerHostFetcherV1,
  overrides: Partial<ConstructorParameters<typeof ComputerHostClient>[0]> = {},
): ComputerHostClient {
  let counter = 0;
  return new ComputerHostClient({
    fetcher,
    hostToken: "host-token",
    identity: { userId: "user-1" },
    tenant: { botId: "bot-1" },
    newEffectId: () => `effect-${(counter += 1)}`,
    ...overrides,
  });
}

function exitFrames(
  stdout: string,
  stderr = "",
): readonly ComputerHostExecFrameV1[] {
  return [
    { type: "stdout", dataBase64: base64(stdout) },
    ...(stderr
      ? [{ type: "stderr" as const, dataBase64: base64(stderr) }]
      : []),
    { type: "exit", exitCode: 0, outputTruncated: false },
  ];
}

describe("ComputerHostClient envelope", () => {
  test("carries version, effect, identity, tenant, and credential reference", async () => {
    const { fetcher, calls } = recorder(() =>
      Response.json({
        version: 1,
        effectId: "effect-1",
        spriteName: "frockbot-abc",
        directory: "/home/box/agent-data/agents/bot-1",
        generation: 3,
      }),
    );
    const result = await client(fetcher).open();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.pathname).toBe(COMPUTER_HOST_ROUTES.open);
    expect(calls[0]?.token).toBe("host-token");
    expect(calls[0]?.body).toEqual({
      version: 1,
      effectId: "effect-1",
      identity: { userId: "user-1" },
      tenant: { botId: "bot-1" },
      // The Durable Object never holds SPRITES_TOKEN: what crosses the seam is
      // a reference the host resolves.
      credentialRef: "sprites:user:user-1",
    });
    expect(result.spriteName).toBe("frockbot-abc");
    expect(result.generation).toBe(3);
  });

  test("uses a caller's effect identifier when it has recorded one", async () => {
    const { fetcher, calls } = recorder(() =>
      Response.json({
        version: 1,
        effectId: "turn-7-exec-2",
        cancelled: true,
      }),
    );
    await client(fetcher).cancel("turn-7-exec-2");
    expect(calls[0]?.body.effectId).toBe("turn-7-exec-2");
  });

  test("credentialRef is overridable without a protocol change", async () => {
    const { fetcher, calls } = recorder(() =>
      Response.json({ version: 1, effectId: "effect-1", cancelled: false }),
    );
    await client(fetcher, { credentialRef: "broker:lease:xyz" }).cancel(
      "effect-1",
    );
    expect(calls[0]?.body.credentialRef).toBe("broker:lease:xyz");
  });

  test("forTenant keeps the Computer and changes only the Bot", async () => {
    const { fetcher, calls } = recorder(() =>
      Response.json({ version: 1, effectId: "effect-1", cancelled: false }),
    );
    await client(fetcher).forTenant("bot-2").cancel("effect-1");
    expect(calls[0]?.body.identity).toEqual({ userId: "user-1" });
    expect(calls[0]?.body.tenant).toEqual({ botId: "bot-2" });
  });
});

describe("ComputerHostClient open", () => {
  const starting: ComputerHostProvisioningV1 = {
    kind: "provision",
    phase: "starting",
    label: "starting the Computer provisioner",
    index: 0,
    total: 5,
    status: "running",
    resumed: false,
  };
  const installing: ComputerHostProvisioningV1 = {
    ...starting,
    phase: "desktop",
    label: "installing the desktop packages",
    index: 2,
  };

  test("streams provisioning progress before the terminal open result", async () => {
    const result = {
      version: 1 as const,
      effectId: "effect-1",
      spriteName: "frockbot-abc",
      directory: "/home/box/agent-data/agents/bot-1",
      generation: 1,
      provisioning: {
        ...installing,
        phase: "ready",
        label: "the Computer is ready",
        status: "complete" as const,
        index: 5,
      },
    };
    const { fetcher, calls } = recorder(() =>
      openNdjson(
        [
          { type: "progress", progress: starting },
          { type: "progress", progress: installing },
          { type: "result", result },
        ],
        3,
      ),
    );
    const seen: ComputerHostProvisioningV1[] = [];

    const opened = await client(fetcher).open({
      onProgress: (progress: ComputerHostProvisioningV1) => {
        seen.push(progress);
      },
    });

    expect(calls[0]?.body.stream).toBe(true);
    expect(seen).toEqual([starting, installing]);
    expect(opened).toEqual(result);
  });

  test("a stream that ends before its result is unavailable and retryable", async () => {
    const { fetcher } = recorder(() =>
      openNdjson([{ type: "progress", progress: starting }], 5),
    );
    const error = await client(fetcher)
      .open({ onProgress: () => undefined })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ComputerError);
    expect((error as ComputerError).code).toBe("provider-unavailable");
    expect((error as ComputerError).retryable).toBe(true);
  });
});

describe("ComputerHostClient exec", () => {
  test("ships the script in the body and never on an argv", async () => {
    const script = "echo hello\n".repeat(400);
    const { fetcher, calls } = recorder(() => ndjson(exitFrames("hello\n"), 8));
    await client(fetcher).exec({ script, cwd: "/home/box", env: { A: "b" } });

    expect(calls[0]?.pathname).toBe(COMPUTER_HOST_ROUTES.exec);
    expect(calls[0]?.body.script).toBe(script);
    expect(calls[0]?.body.cwd).toBe("/home/box");
    expect(calls[0]?.body.env).toEqual({ A: "b" });
    expect(calls[0]?.body.stream).toBe(true);
  });

  for (const size of [1, 2, 3, 7, 64, 4096]) {
    test(`reassembles NDJSON frames split every ${size} bytes`, async () => {
      const { fetcher } = recorder(() =>
        ndjson(
          [
            { type: "stdout", dataBase64: base64("first line\n") },
            { type: "stderr", dataBase64: base64("a warning\n") },
            { type: "stdout", dataBase64: base64("second line\n") },
            { type: "exit", exitCode: 7, outputTruncated: false },
          ],
          size,
        ),
      );
      const outcome = await client(fetcher).exec({ script: "true" });
      expect(text(outcome.stdout)).toBe("first line\nsecond line\n");
      expect(text(outcome.stderr)).toBe("a warning\n");
      expect(outcome.exitCode).toBe(7);
      expect(outcome.outputTruncated).toBe(false);
    });
  }

  test("reads a final frame that arrived without its trailing newline", async () => {
    const body = `${encodeComputerHostExecFrameV1({
      type: "stdout",
      dataBase64: base64("done"),
    })}${JSON.stringify({
      type: "exit",
      exitCode: 0,
      outputTruncated: false,
    })}`;
    const { fetcher } = recorder(
      () =>
        new Response(body, {
          headers: { "content-type": COMPUTER_HOST_STREAM_MEDIA_TYPE },
        }),
    );
    const outcome = await client(fetcher).exec({ script: "true" });
    expect(text(outcome.stdout)).toBe("done");
    expect(outcome.exitCode).toBe(0);
  });

  test("bounds output at maxOutputBytes and says it truncated", async () => {
    const { fetcher } = recorder(() =>
      ndjson(
        [
          { type: "stdout", dataBase64: base64("0123456789") },
          { type: "stdout", dataBase64: base64("abcdefghij") },
          { type: "exit", exitCode: 0, outputTruncated: false },
        ],
        5,
      ),
    );
    const outcome = await client(fetcher).exec({
      script: "true",
      maxOutputBytes: 12,
    });
    expect(text(outcome.stdout)).toBe("0123456789ab");
    expect(outcome.outputTruncated).toBe(true);
    // The exit frame still arrived: the read is bounded, not abandoned.
    expect(outcome.exitCode).toBe(0);
  });

  test("carries the host's own truncation through", async () => {
    const { fetcher } = recorder(() =>
      ndjson(
        [
          { type: "stdout", dataBase64: base64("x") },
          { type: "exit", exitCode: 0, outputTruncated: true },
        ],
        3,
      ),
    );
    const outcome = await client(fetcher).exec({ script: "true" });
    expect(outcome.outputTruncated).toBe(true);
  });

  test("an error frame becomes the ComputerError it declares", async () => {
    const { fetcher } = recorder(() =>
      ndjson(
        [
          { type: "stdout", dataBase64: base64("partial") },
          {
            type: "error",
            code: "human-control-active",
            message: "a human holds this Computer",
            retryable: true,
          },
        ],
        6,
      ),
    );
    const error = await client(fetcher)
      .exec({ script: "true" })
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ComputerError);
    expect((error as ComputerError).code).toBe("human-control-active");
    expect((error as ComputerError).retryable).toBe(true);
  });

  test("a stream that ends before the exit frame is unavailable, not failed", async () => {
    const { fetcher } = recorder(() =>
      ndjson([{ type: "stdout", dataBase64: base64("half") }], 4),
    );
    const error = await client(fetcher)
      .exec({ script: "true" })
      .catch((thrown: unknown) => thrown);
    expect((error as ComputerError).code).toBe("provider-unavailable");
    expect((error as ComputerError).retryable).toBe(true);
  });

  test("a buffered exec decodes one result", async () => {
    const { fetcher, calls } = recorder(() =>
      Response.json({
        version: 1,
        effectId: "effect-1",
        exitCode: 0,
        stdoutBase64: base64("buffered"),
        stderrBase64: "",
        outputTruncated: false,
      }),
    );
    const outcome = await client(fetcher).exec({
      script: "true",
      stream: false,
    });
    expect(calls[0]?.body.stream).toBe(false);
    expect(text(outcome.stdout)).toBe("buffered");
    expect(outcome.stderr).toHaveLength(0);
  });

  test("extra stdin travels base64 in the body", async () => {
    const { fetcher, calls } = recorder(() => ndjson(exitFrames(""), 32));
    await client(fetcher).exec({
      script: "cat",
      stdin: new TextEncoder().encode("payload"),
    });
    expect(calls[0]?.body.stdinBase64).toBe(base64("payload"));
  });
});

describe("ComputerHostClient failures", () => {
  test("computer-updating is provider-neutral updating and retryable", async () => {
    const { fetcher } = recorder(() =>
      Response.json(
        computerHostProblemV1(
          "computer-updating",
          "Updating the Computer runtime",
        ),
        { status: 409 },
      ),
    );
    const error = await client(fetcher)
      .exec({ script: "true" })
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ComputerError);
    expect((error as ComputerError).code).toBe("updating");
    expect((error as ComputerError).retryable).toBe(true);
    expect((error as ComputerError).message).toBe(
      "Updating the Computer runtime",
    );
  });

  test("429 is limit-exceeded and retryable", async () => {
    const { fetcher } = recorder(() =>
      Response.json(
        computerHostProblemV1(
          "limit-exceeded",
          "This Computer is already running 4 effects",
        ),
        { status: 429 },
      ),
    );
    const error = await client(fetcher)
      .exec({ script: "true" })
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ComputerError);
    expect((error as ComputerError).code).toBe("limit-exceeded");
    expect((error as ComputerError).retryable).toBe(true);
  });

  test("a 429 with an undecodable body is still limit-exceeded", async () => {
    const { fetcher } = recorder(
      () => new Response("Too Many Requests", { status: 429 }),
    );
    const error = await client(fetcher)
      .exec({ script: "true" })
      .catch((thrown: unknown) => thrown);
    expect((error as ComputerError).code).toBe("limit-exceeded");
  });

  test("a wrong token is a provider failure and not retried", async () => {
    const { fetcher } = recorder(() =>
      Response.json(
        computerHostProblemV1("not-authorized", "token is missing or wrong"),
        { status: 401 },
      ),
    );
    const error = await client(fetcher)
      .exec({ script: "true" })
      .catch((thrown: unknown) => thrown);
    expect((error as ComputerError).code).toBe("provider-failure");
    expect((error as ComputerError).retryable).toBe(false);
  });

  test("a host timeout is provider-unavailable", async () => {
    const { fetcher } = recorder(() =>
      Response.json(computerHostProblemV1("timeout", "exec exceeded 120s"), {
        status: 504,
      }),
    );
    const error = await client(fetcher)
      .exec({ script: "true" })
      .catch((thrown: unknown) => thrown);
    expect((error as ComputerError).code).toBe("provider-unavailable");
  });

  test("an unreachable host is provider-unavailable and retryable", async () => {
    const error = await client({
      fetch: () => Promise.reject(new Error("no such service binding")),
    })
      .exec({ script: "true" })
      .catch((thrown: unknown) => thrown);
    expect((error as ComputerError).code).toBe("provider-unavailable");
    expect((error as ComputerError).retryable).toBe(true);
    expect((error as ComputerError).message).toContain(
      "no such service binding",
    );
  });

  test("the client's own deadline expiring is provider-unavailable", async () => {
    const error = await client(hanging())
      .exec({ script: "sleep 600", timeoutMs: 5 }, { timeoutMs: 5 })
      .catch((thrown: unknown) => thrown);
    expect((error as ComputerError).code).toBe("provider-unavailable");
    expect((error as ComputerError).retryable).toBe(true);
  }, 10_000);

  test("a caller's abort is aborted, and posts a cancel for the same effect", async () => {
    const calls: RecordedCall[] = [];
    const hangs = hanging(calls);
    const cancels: RecordedCall[] = [];
    const fetcher: ComputerHostFetcherV1 = {
      async fetch(request: Request): Promise<Response> {
        if (new URL(request.url).pathname === COMPUTER_HOST_ROUTES.cancel) {
          cancels.push({
            pathname: new URL(request.url).pathname,
            token: request.headers.get(COMPUTER_HOST_TOKEN_HEADER),
            body: (await request.json()) as Record<string, unknown>,
          });
          return Response.json({
            version: 1,
            effectId: "effect-1",
            cancelled: true,
          });
        }
        return hangs.fetch(request);
      },
    };
    const controller = new AbortController();
    const running = client(fetcher)
      .exec({ script: "sleep 600" }, { signal: controller.signal })
      .catch((thrown: unknown) => thrown);
    await Bun.sleep(10);
    controller.abort();
    const error = await running;

    expect((error as ComputerError).code).toBe("aborted");
    expect((error as ComputerError).retryable).toBe(false);
    await Bun.sleep(10);
    // "a dropped connection is an outcome, not a failure": the abort alone
    // leaves the process running on the Computer, so the cancel names it.
    expect(cancels).toHaveLength(1);
    expect(cancels[0]?.body.effectId).toBe(calls[0]?.body.effectId);
  }, 10_000);

  test("a result the decoder refuses is not silently accepted", async () => {
    const { fetcher } = recorder(() =>
      Response.json({
        version: 1,
        effectId: "effect-1",
        spriteName: "frockbot-abc",
        directory: "/home/box",
        generation: 1,
        // Not in the schema. A caller must not be able to smuggle a field
        // through the seam.
        smuggled: "value",
      }),
    );
    await expect(client(fetcher).open()).rejects.toThrow(/unknown field/);
  });

  test("a result whose version is not 1 is refused", async () => {
    const { fetcher } = recorder(() =>
      Response.json({
        version: 2,
        effectId: "effect-1",
        spriteName: "frockbot-abc",
        directory: "/home/box",
        generation: 1,
      }),
    );
    await expect(client(fetcher).open()).rejects.toThrow(/version is not 1/);
  });
});

describe("ComputerHostClient operations", () => {
  test("file bytes round-trip as base64 and never as text", async () => {
    const bytes = Uint8Array.from([0, 1, 250, 255, 10]);
    const { fetcher, calls } = recorder((call) =>
      call.pathname === COMPUTER_HOST_ROUTES["file/write"]
        ? Response.json({
            version: 1,
            effectId: "effect-1",
            entry: {
              path: "/home/box/x.bin",
              kind: "file",
              size: 5,
              mode: 0o644,
            },
          })
        : Response.json({
            version: 1,
            effectId: "effect-2",
            entry: {
              path: "/home/box/x.bin",
              kind: "file",
              size: 5,
              mode: 0o644,
            },
            bytesBase64: Buffer.from(bytes).toString("base64"),
          }),
    );
    const host = client(fetcher);
    const written = await host.fileWrite("/home/box/x.bin", bytes);
    expect(written.entry.size).toBe(5);
    expect(calls[0]?.body.bytesBase64).toBe(
      Buffer.from(bytes).toString("base64"),
    );
    const read = await host.fileRead("/home/box/x.bin");
    expect([...Buffer.from(read.bytesBase64, "base64")]).toEqual([...bytes]);
  });

  test("control and viewer are reachable from the Durable Object path", async () => {
    const { fetcher, calls } = recorder((call) =>
      call.pathname === COMPUTER_HOST_ROUTES.control
        ? Response.json({
            version: 1,
            effectId: "effect-1",
            action: "acquire",
            ownerId: "owner-1",
            expiresAt: "2026-08-31T00:00:00.000Z",
          })
        : Response.json({
            version: 1,
            effectId: "effect-2",
            session: {
              id: "token-1",
              url: "https://sprite.example/vnc.html",
              expiresAt: "2026-08-31T00:00:00.000Z",
            },
          }),
    );
    const host = client(fetcher);
    const lease = await host.control("acquire", "owner-1", 900);
    expect(lease.expiresAt).toBe("2026-08-31T00:00:00.000Z");
    expect(calls[0]?.body.maxAgeSeconds).toBe(900);

    const viewer = await host.viewer("open");
    expect(viewer.session?.url).toBe("https://sprite.example/vnc.html");
    await host.viewer("renew", { sessionId: "token-1" });
    expect(calls.at(-1)?.body).toMatchObject({
      action: "renew",
      sessionId: "token-1",
    });
  });

  test("a declared service reattach reports its status", async () => {
    const { fetcher } = recorder(() =>
      Response.json({
        version: 1,
        effectId: "effect-1",
        name: "frockbot-desktop",
        status: "unavailable",
      }),
    );
    const result = await client(fetcher).service("frockbot-desktop");
    expect(result.status).toBe("unavailable");
  });

  test("file list and delete decode at the seam", async () => {
    const { fetcher } = recorder((call) =>
      call.pathname === COMPUTER_HOST_ROUTES["file/list"]
        ? Response.json({
            version: 1,
            effectId: "effect-1",
            entries: [
              { path: "/home/box/a", kind: "file", size: 1, mode: 0o644 },
              { path: "/home/box/b", kind: "directory", size: 0, mode: 0o755 },
            ],
            truncated: false,
          })
        : Response.json({
            version: 1,
            effectId: "effect-2",
            path: "/home/box/a",
            deleted: true,
          }),
    );
    const host = client(fetcher);
    const listed = await host.fileList("/home/box", { recursive: true });
    expect(listed.entries.map((entry) => entry.kind)).toEqual([
      "file",
      "directory",
    ]);
    const deleted = await host.fileDelete("/home/box/a");
    expect(deleted.deleted).toBe(true);
  });
});
