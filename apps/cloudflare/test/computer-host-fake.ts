// A faithful stand-in for the `COMPUTER_HOST` service binding.
//
// Why a stand-in and not the real Worker: the Computer host's answer comes
// from a container, and `@cloudflare/vitest-plugin` cannot build, tag, or
// start a container image — its pool never touches Docker. A real container
// therefore only runs under `wrangler dev` or in production, and
// `apps/computer-host/live-test.ts` is what drives it there.
//
// What is real here: the wire contract. This module runs
// `@frockbot/computer/host-protocol` verbatim — the same
// `decodeComputerHostHttpRequestV1` at the seam, the same `problem()` refusal
// shape, the same open and exec NDJSON framing, the same
// `x-frockbot-host-token` check, and the real Worker's own
// `computerHostShardV1`, so a test can prove a User's calls all land on one
// shard. Only the Computer is different: an in-memory file map and a scripted
// exec table instead of a Sprite.
//
// It runs in Node (a Miniflare `serviceBindings` function), so the test that
// drives it lives in workerd and cannot touch its state directly. Control
// therefore travels over the same binding, under `/__fake/*`: a route the real
// host does not serve and the client never calls.
import {
  COMPUTER_HOST_STREAM_MEDIA_TYPE,
  COMPUTER_HOST_TOKEN_HEADER,
  computerHostOperationKindV1,
  decodeComputerHostHttpRequestV1,
  encodeComputerHostExecFrameV1,
  encodeComputerHostOpenFrameV1,
  problem,
  type ComputerHostErrorCodeV1,
  type ComputerHostExecFrameV1,
  type ComputerHostRequestV1,
} from "@frockbot/computer/host-protocol";
import { computerHostShardV1 } from "../../computer-host/src/router.ts";

/** The token the fake accepts. The configs hand the same string to the app. */
export const FAKE_COMPUTER_HOST_TOKEN = "fake-computer-host-token";

/** The shard count the fake routes with, matching `wrangler.jsonc`. */
export const FAKE_COMPUTER_HOST_SHARDS = 2;

/** One call the fake answered, as the test reads it back. */
export interface FakeComputerHostCall {
  kind: string;
  effectId: string;
  userId: string;
  botId: string;
  credentialRef: string;
  /** The shard the real Worker's own router would have chosen. */
  shard: string;
  script?: string;
  cwd?: string;
  env?: Record<string, string>;
  stdinBase64?: string;
  path?: string;
  action?: string;
  name?: string;
  stream?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

/**
 * How the fake answers one exec whose script contains `match`.
 *
 * The knobs are the four things a Durable Object client has to survive and
 * cannot provoke against a real host on demand: an exit code, a transport that
 * splits frames wherever it likes, a host that never answers, and a host that
 * sheds load.
 */
export interface FakeExecScript {
  /** Substring of the script this rule answers. Omit to match every exec. */
  match?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  signal?: string;
  outputTruncated?: boolean;
  /** Frames to emit instead of the stdout/stderr/exit trio. */
  frames?: ComputerHostExecFrameV1[];
  /** Bytes per transport chunk. The frame boundary is the newline, not this. */
  chunkBytes?: number;
  /** Milliseconds to wait before answering anything at all. */
  hangMs?: number;
  /** Answer this problem instead of running. */
  refuse?: { status: number; code: ComputerHostErrorCodeV1; message: string };
}

interface FakeState {
  scripts: FakeExecScript[];
  files: Map<string, string>;
  calls: FakeComputerHostCall[];
  cancelled: Set<string>;
  generation: number;
  /**
   * The control leases, keyed exactly as the Sprite's `control.sh` keys them:
   * one directory per lease key on one box. A `bot` lease is keyed by tenant, a
   * `desktop-gui` lease by the box — which is what makes it User-wide.
   */
  leases: Map<string, { ownerId: string; expiresAt: number }>;
}

function encodeText(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function fileKey(userId: string, path: string): string {
  return `${userId}\u0000${path}`;
}

function callOf(
  request: ComputerHostRequestV1,
  shards: number,
): FakeComputerHostCall {
  const operation = request.operation;
  return {
    kind: operation.kind,
    effectId: request.effectId,
    userId: request.identity.userId,
    botId: request.tenant.botId,
    credentialRef: request.credentialRef,
    shard: computerHostShardV1(request.identity.userId, shards),
    ...("script" in operation ? { script: operation.script } : {}),
    ...("cwd" in operation && operation.cwd !== undefined
      ? { cwd: operation.cwd }
      : {}),
    ...("env" in operation && operation.env !== undefined
      ? { env: operation.env }
      : {}),
    ...("stdinBase64" in operation && operation.stdinBase64 !== undefined
      ? { stdinBase64: operation.stdinBase64 }
      : {}),
    ...("path" in operation ? { path: operation.path } : {}),
    ...("action" in operation ? { action: operation.action } : {}),
    ...("name" in operation ? { name: operation.name } : {}),
    ...("stream" in operation ? { stream: operation.stream } : {}),
    ...("timeoutMs" in operation ? { timeoutMs: operation.timeoutMs } : {}),
    ...("maxOutputBytes" in operation
      ? { maxOutputBytes: operation.maxOutputBytes }
      : {}),
  };
}

function framesFor(rule: FakeExecScript): ComputerHostExecFrameV1[] {
  if (rule.frames) return rule.frames;
  return [
    ...(rule.stdout
      ? [{ type: "stdout" as const, dataBase64: encodeText(rule.stdout) }]
      : []),
    ...(rule.stderr
      ? [{ type: "stderr" as const, dataBase64: encodeText(rule.stderr) }]
      : []),
    {
      type: "exit" as const,
      exitCode: rule.exitCode === undefined ? 0 : rule.exitCode,
      ...(rule.signal ? { signal: rule.signal } : {}),
      outputTruncated: rule.outputTruncated ?? false,
    },
  ];
}

/**
 * A delay that never holds the process open.
 *
 * A scripted hang is deliberately longer than the deadline it is provoking, so
 * its timer outlives the test that armed it. Unreferenced, it stops Vitest
 * hanging at teardown waiting for a hang nobody is listening to any more.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer: ReturnType<typeof setTimeout> & { unref?: () => void } =
      setTimeout(resolve, ms);
    timer.unref?.();
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Streams NDJSON in chunks of a declared size, wherever those boundaries fall.
 *
 * The whole point is that they fall in the wrong places: a client that treats
 * a chunk as a frame passes against a well-behaved host and fails here.
 */
function ndjsonBody(
  frames: readonly ComputerHostExecFrameV1[],
  chunkBytes: number,
): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(
    frames.map(encodeComputerHostExecFrameV1).join(""),
  );
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(offset, offset + chunkBytes));
      offset += chunkBytes;
      // A tick between chunks, so the transport has a chance to deliver them
      // separately rather than coalescing the whole body into one read.
      await sleep(1);
    },
  });
}

export interface ComputerHostFake {
  fetch(request: Request): Promise<Response>;
  reset(): void;
}

export function createComputerHostFake(
  options: {
    token?: string;
    shards?: number;
    /** Bounds a scripted hang, so a stuck test dies rather than hanging CI. */
    maximumHangMs?: number;
  } = {},
): ComputerHostFake {
  const token = options.token ?? FAKE_COMPUTER_HOST_TOKEN;
  const shards = options.shards ?? FAKE_COMPUTER_HOST_SHARDS;
  const maximumHangMs = options.maximumHangMs ?? 30_000;
  const state: FakeState = {
    scripts: [],
    files: new Map(),
    calls: [],
    cancelled: new Set(),
    generation: 1,
    leases: new Map(),
  };

  const reset = () => {
    state.scripts = [];
    state.files.clear();
    state.calls = [];
    state.cancelled.clear();
    state.generation = 1;
    state.leases.clear();
  };

  async function control(
    pathname: string,
    request: Request,
  ): Promise<Response> {
    if (pathname === "/__fake/reset") {
      reset();
      return Response.json({ ok: true });
    }
    if (pathname === "/__fake/calls") {
      return Response.json({ calls: state.calls });
    }
    if (pathname === "/__fake/exec") {
      const rule = (await request.json()) as FakeExecScript;
      // Last registered wins, so a test can narrow a broad rule.
      state.scripts.unshift(rule);
      return Response.json({ ok: true, scripts: state.scripts.length });
    }
    if (pathname === "/__fake/file") {
      const seed = (await request.json()) as {
        userId: string;
        path: string;
        text: string;
      };
      state.files.set(fileKey(seed.userId, seed.path), encodeText(seed.text));
      return Response.json({ ok: true });
    }
    if (pathname === "/__fake/generation") {
      // A reprovision, as the Computer reports it: `open` answers a higher
      // generation, and everything launched under the old one is gone.
      const seed = (await request.json()) as { generation: number };
      state.generation = seed.generation;
      return Response.json({ ok: true, generation: state.generation });
    }
    if (pathname === "/__fake/file-bytes") {
      // Binary, for a file that is not text: a screenshot is a PNG, and
      // seeding it through the text route would seed a different file.
      const seed = (await request.json()) as {
        userId: string;
        path: string;
        bytesBase64: string;
      };
      state.files.set(fileKey(seed.userId, seed.path), seed.bytesBase64);
      return Response.json({ ok: true });
    }
    if (pathname === "/__fake/files") {
      return Response.json({
        files: [...state.files.entries()].map(([key, bytesBase64]) => {
          const [userId = "", path = ""] = key.split("\u0000");
          return { userId, path, bytesBase64 };
        }),
      });
    }
    return Response.json(
      { error: "no such fake control route" },
      {
        status: 404,
      },
    );
  }

  function exec(
    request: ComputerHostRequestV1,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    const operation = request.operation;
    if (operation.kind !== "exec") {
      return Promise.resolve(problem(400, "invalid-request", "not an exec"));
    }
    const rule =
      state.scripts.find(
        (candidate) =>
          candidate.match === undefined ||
          operation.script.includes(candidate.match),
      ) ?? {};

    const answer = async (): Promise<Response> => {
      if (rule.hangMs) {
        await sleep(Math.min(rule.hangMs, maximumHangMs), signal);
        // A hang is the absence of an answer, not a slow one: whatever the
        // caller does with its deadline, this never produces an exit frame.
        return problem(
          504,
          "timeout",
          "the fake Computer host never answered",
          true,
        );
      }
      if (rule.refuse) {
        return problem(
          rule.refuse.status,
          rule.refuse.code,
          rule.refuse.message,
        );
      }
      const frames = framesFor(rule);
      if (!operation.stream) {
        const exit = frames.find((frame) => frame.type === "exit");
        const collect = (type: "stdout" | "stderr") =>
          Buffer.concat(
            frames
              .filter((frame) => frame.type === type)
              .map((frame) =>
                Buffer.from(
                  (frame as { dataBase64: string }).dataBase64,
                  "base64",
                ),
              ),
          ).toString("base64");
        return Response.json({
          version: 1,
          effectId: request.effectId,
          exitCode: exit?.type === "exit" ? exit.exitCode : null,
          stdoutBase64: collect("stdout"),
          stderrBase64: collect("stderr"),
          outputTruncated: exit?.type === "exit" ? exit.outputTruncated : false,
        });
      }
      return new Response(ndjsonBody(frames, rule.chunkBytes ?? 4_096), {
        headers: { "content-type": COMPUTER_HOST_STREAM_MEDIA_TYPE },
      });
    };
    return answer();
  }

  function file(request: ComputerHostRequestV1): Response {
    const operation = request.operation;
    const userId = request.identity.userId;
    if (operation.kind === "file/write") {
      state.files.set(fileKey(userId, operation.path), operation.bytesBase64);
      return Response.json({
        version: 1,
        effectId: request.effectId,
        entry: {
          path: operation.path,
          kind: "file",
          size: Buffer.from(operation.bytesBase64, "base64").byteLength,
          mode: operation.mode ?? 0o644,
        },
      });
    }
    if (operation.kind === "file/read" || operation.kind === "file/stat") {
      const held = state.files.get(fileKey(userId, operation.path));
      if (held === undefined) {
        return problem(404, "not-found", `no such file: ${operation.path}`);
      }
      const entry = {
        path: operation.path,
        kind: "file" as const,
        size: Buffer.from(held, "base64").byteLength,
        mode: 0o644,
      };
      return Response.json({
        version: 1,
        effectId: request.effectId,
        entry,
        ...(operation.kind === "file/read" ? { bytesBase64: held } : {}),
      });
    }
    if (operation.kind === "file/list") {
      const prefix = operation.path === "/" ? "/" : `${operation.path}/`;
      const entries = [...state.files.entries()]
        .filter(([key]) => key.startsWith(`${userId}\u0000${prefix}`))
        .map(([key, bytesBase64]) => ({
          path: key.slice(userId.length + 1),
          kind: "file" as const,
          size: Buffer.from(bytesBase64, "base64").byteLength,
          mode: 0o644,
        }));
      return Response.json({
        version: 1,
        effectId: request.effectId,
        entries,
        truncated: false,
      });
    }
    if (operation.kind !== "file/delete") {
      return problem(400, "invalid-request", "not a file operation");
    }
    const deleted = state.files.delete(fileKey(userId, operation.path));
    return Response.json({
      version: 1,
      effectId: request.effectId,
      path: operation.path,
      deleted,
    });
  }

  /**
   * The control lease, with the same rule `control.sh` runs on the Sprite: one
   * owner per key, a fresh lease refuses a different owner, and a release only
   * releases your own. Faking a lease that always grants would prove nothing —
   * the whole claim of the `desktop-gui` scope is that a *second* caller is
   * refused, and named the holder.
   */
  function control_(request: ComputerHostRequestV1): Response {
    const operation = request.operation;
    if (operation.kind !== "control") {
      return problem(400, "invalid-request", "not a control call");
    }
    const key = `${request.identity.userId} ${
      operation.scope === "desktop-gui"
        ? "desktop-gui.lease"
        : request.tenant.botId
    }`;
    const now = Date.now();
    const held = state.leases.get(key);
    const fresh = held !== undefined && held.expiresAt > now;
    if (operation.action === "release") {
      if (held?.ownerId === operation.ownerId) state.leases.delete(key);
      return Response.json({
        version: 1,
        effectId: request.effectId,
        action: "release",
        ownerId: operation.ownerId,
      });
    }
    if (fresh && held.ownerId !== operation.ownerId) {
      return problem(
        409,
        "human-control-active",
        `This computer's control lease is held by ${held.ownerId}`,
      );
    }
    if (operation.action === "renew" && !fresh) {
      return problem(
        409,
        "human-control-active",
        "Human control lease owner changed",
      );
    }
    const expiresAt = now + operation.maxAgeSeconds * 1_000;
    state.leases.set(key, { ownerId: operation.ownerId, expiresAt });
    return Response.json({
      version: 1,
      effectId: request.effectId,
      action: operation.action,
      ownerId: operation.ownerId,
      expiresAt: new Date(expiresAt).toISOString(),
    });
  }

  async function serve(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname.startsWith("/__fake/")) return control(pathname, request);
    if (pathname === "/healthz") {
      return Response.json({ ok: true, shards });
    }
    if (!computerHostOperationKindV1(pathname)) {
      return problem(404, "not-found", "no such Computer host route");
    }
    // The real Worker refuses before it decodes, and so does this: a token
    // that is wrong must never reach a Computer, fake or otherwise.
    if (request.headers.get(COMPUTER_HOST_TOKEN_HEADER) !== token) {
      return problem(
        401,
        "not-authorized",
        "Computer host token is missing or wrong",
      );
    }
    const decoded = await decodeComputerHostHttpRequestV1(request);
    if (!decoded.ok) return decoded.response;
    const value = decoded.value;
    state.calls.push(callOf(value, shards));

    switch (value.operation.kind) {
      case "open": {
        const result = {
          version: 1,
          effectId: value.effectId,
          spriteName: `frockbot-fake-${computerHostShardV1(
            value.identity.userId,
            shards,
          ).replace(/[^a-z0-9-]/g, "")}`,
          directory: `/home/box/agent-data/agents/${value.tenant.botId}`,
          display: ":100",
          generation: state.generation,
        } as const;
        return value.operation.stream
          ? new Response(
              encodeComputerHostOpenFrameV1({ type: "result", result }),
              {
                headers: { "content-type": COMPUTER_HOST_STREAM_MEDIA_TYPE },
              },
            )
          : Response.json(result);
      }
      case "exec":
        return exec(value, request.signal);
      case "file/read":
      case "file/write":
      case "file/list":
      case "file/stat":
      case "file/delete":
        return file(value);
      case "control":
        return control_(value);
      case "viewer":
        return value.operation.action === "revoke"
          ? Response.json({ version: 1, effectId: value.effectId })
          : Response.json({
              version: 1,
              effectId: value.effectId,
              session: {
                id: "fake-viewer-token",
                url: "https://fake-sprite.example/index.html#autoconnect=1&reconnect=1&resize=scale&view_only=1&path=websockify%3Ftoken%3Dfake-viewer-token&password=fake-password",
                expiresAt: new Date(Date.now() + 90_000).toISOString(),
              },
            });
      case "service":
        return Response.json({
          version: 1,
          effectId: value.effectId,
          name: value.operation.name,
          status: "running",
        });
      case "cancel":
        state.cancelled.add(value.effectId);
        return Response.json({
          version: 1,
          effectId: value.effectId,
          cancelled: true,
        });
    }
  }

  return { fetch: serve, reset };
}
