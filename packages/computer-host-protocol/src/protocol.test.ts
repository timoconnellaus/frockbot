import { describe, expect, test } from "bun:test";
import {
  COMPUTER_HOST_LIMITS,
  COMPUTER_HOST_ROUTES,
  ComputerHostExecFrameReaderV1,
  computerHostOperationKindV1,
  computerHostProblemV1,
  decodeBase64FieldV1,
  decodeComputerHostCancelResultV1,
  decodeComputerHostControlResultV1,
  decodeComputerHostExecFrameV1,
  decodeComputerHostExecResultV1,
  decodeComputerHostFileDeleteResultV1,
  decodeComputerHostFileListResultV1,
  decodeComputerHostFileReadResultV1,
  decodeComputerHostFileStatResultV1,
  decodeComputerHostFileWriteResultV1,
  decodeComputerHostHttpRequestV1,
  decodeComputerHostOpenResultV1,
  decodeComputerHostProblemV1,
  decodeComputerHostRequestV1,
  decodeComputerHostServiceResultV1,
  decodeComputerHostViewerResultV1,
  decodeComputerPathV1,
  encodeComputerHostExecFrameV1,
  encodeComputerHostRequestV1,
  problem,
  type ComputerHostOperationV1,
} from "./protocol.ts";

const envelope = {
  version: 1 as const,
  effectId: "effect-1",
  identity: { userId: "user-1" },
  tenant: { botId: "bot-1" },
  credentialRef: "sprites:user:user-1",
};

function request(operation: ComputerHostOperationV1): Record<string, unknown> {
  return encodeComputerHostRequestV1({ ...envelope, operation });
}

describe("routes", () => {
  test("every operation kind has a route and resolves back to it", () => {
    for (const [kind, route] of Object.entries(COMPUTER_HOST_ROUTES)) {
      expect(computerHostOperationKindV1(route)).toBe(
        kind as keyof typeof COMPUTER_HOST_ROUTES,
      );
    }
  });

  test("an unknown pathname resolves to no operation", () => {
    expect(computerHostOperationKindV1("/v1/computer/smoke")).toBeUndefined();
  });
});

describe("envelope", () => {
  test("decodes the declared envelope on every operation", () => {
    const decoded = decodeComputerHostRequestV1(
      "open",
      request({ kind: "open" }),
    );
    expect(decoded).toEqual({ ...envelope, operation: { kind: "open" } });
  });

  test("refuses a version other than 1", () => {
    expect(() =>
      decodeComputerHostRequestV1("open", {
        ...request({ kind: "open" }),
        version: 2,
      }),
    ).toThrow(/version is not 1/);
  });

  test("refuses a field the schema does not declare", () => {
    expect(() =>
      decodeComputerHostRequestV1("open", {
        ...request({ kind: "open" }),
        spriteName: "frockbot-elsewhere",
      }),
    ).toThrow(/unknown field/);
  });

  test("refuses a missing identity", () => {
    const body = request({ kind: "open" }) as Record<string, unknown>;
    delete body.identity;
    expect(() => decodeComputerHostRequestV1("open", body)).toThrow(
      /identity must be an object/,
    );
  });

  test("refuses an identity carrying anything but a userId", () => {
    expect(() =>
      decodeComputerHostRequestV1("open", {
        ...request({ kind: "open" }),
        identity: { userId: "user-1", token: "leaked" },
      }),
    ).toThrow(/Computer identity has an unknown field/);
  });

  test("refuses an over-long credential reference", () => {
    expect(() =>
      decodeComputerHostRequestV1("open", {
        ...request({ kind: "open" }),
        credentialRef: "a".repeat(COMPUTER_HOST_LIMITS.credentialRef + 1),
      }),
    ).toThrow(/exceeds 256 characters/);
  });
});

describe("exec", () => {
  const exec: ComputerHostOperationV1 = {
    kind: "exec",
    script: "printf hello",
    timeoutMs: 1_000,
    maxOutputBytes: 4_096,
    stream: true,
  };

  test("round-trips a script, cwd, env, and stdin", () => {
    const operation: ComputerHostOperationV1 = {
      ...exec,
      cwd: "/home/box/agent-data",
      env: { FROCKBOT_BOT_ID: "bot-1" },
      stdinBase64: btoa("payload"),
    };
    expect(
      decodeComputerHostRequestV1("exec", request(operation)).operation,
    ).toEqual(operation);
  });

  test("accepts a script far larger than the argv limit that produced the 431", () => {
    const script = "#".repeat(8_192);
    const decoded = decodeComputerHostRequestV1(
      "exec",
      request({ ...exec, script }),
    );
    expect(decoded.operation).toMatchObject({ kind: "exec", script });
  });

  test("refuses a script beyond the declared ceiling", () => {
    expect(() =>
      decodeComputerHostRequestV1(
        "exec",
        request({
          ...exec,
          script: "x".repeat(COMPUTER_HOST_LIMITS.script + 1),
        }),
      ),
    ).toThrow(/exceeds 1000000 characters/);
  });

  test("refuses a timeout beyond the ceiling", () => {
    expect(() =>
      decodeComputerHostRequestV1(
        "exec",
        request({ ...exec, timeoutMs: COMPUTER_HOST_LIMITS.execTimeoutMs + 1 }),
      ),
    ).toThrow(/timeout must be between/);
  });

  test("refuses an output limit beyond the ceiling", () => {
    expect(() =>
      decodeComputerHostRequestV1(
        "exec",
        request({
          ...exec,
          maxOutputBytes: COMPUTER_HOST_LIMITS.maxOutputBytes + 1,
        }),
      ),
    ).toThrow(/output limit must be between/);
  });

  test("refuses a relative cwd", () => {
    expect(() =>
      decodeComputerHostRequestV1(
        "exec",
        request({ ...exec, cwd: "agent-data" }),
      ),
    ).toThrow(/absolute normalized Computer path/);
  });

  test("refuses an env name that is not a shell identifier", () => {
    expect(() =>
      decodeComputerHostRequestV1("exec", {
        ...request(exec),
        env: { "PATH;rm -rf /": "x" },
      }),
    ).toThrow(/env name is invalid/);
  });

  test("refuses more env entries than the declared ceiling", () => {
    const env = Object.fromEntries(
      Array.from(
        { length: COMPUTER_HOST_LIMITS.envEntries + 1 },
        (_value, index) => [`VAR_${index}`, "x"],
      ),
    );
    expect(() =>
      decodeComputerHostRequestV1("exec", { ...request(exec), env }),
    ).toThrow(/env exceeds 64 entries/);
  });

  test("refuses stdin that is not base64", () => {
    expect(() =>
      decodeComputerHostRequestV1(
        "exec",
        request({ ...exec, stdinBase64: "not base64!" }),
      ),
    ).toThrow(/not valid base64/);
  });

  test("refuses a non-boolean stream flag", () => {
    expect(() =>
      decodeComputerHostRequestV1("exec", {
        ...request(exec),
        stream: "yes",
      }),
    ).toThrow(/stream must be a boolean/);
  });
});

describe("paths", () => {
  test("accepts an absolute normalized path", () => {
    expect(decodeComputerPathV1("/home/box/agent-data/notes.md")).toBe(
      "/home/box/agent-data/notes.md",
    );
  });

  test.each([
    ["relative", "home/box"],
    ["traversal", "/home/box/../etc/shadow"],
    ["dot segment", "/home/./box"],
    ["double slash", "/home//box"],
    ["backslash", "/home\\box"],
    ["trailing slash", "/home/box/"],
    ["control character", "/home/box/\u0007bell"],
  ])("refuses a %s path", (_label, path) => {
    expect(() => decodeComputerPathV1(path)).toThrow();
  });
});

describe("file operations", () => {
  test("round-trips a write with a mode", () => {
    const operation: ComputerHostOperationV1 = {
      kind: "file/write",
      path: "/home/box/notes.md",
      bytesBase64: btoa("hello"),
      mode: 0o600,
    };
    expect(
      decodeComputerHostRequestV1("file/write", request(operation)).operation,
    ).toEqual(operation);
  });

  test("defaults recursive to false on a list", () => {
    expect(
      decodeComputerHostRequestV1(
        "file/list",
        request({ kind: "file/list", path: "/home/box", recursive: false }),
      ).operation,
    ).toEqual({ kind: "file/list", path: "/home/box", recursive: false });
  });

  test("refuses a mode outside the POSIX bits", () => {
    expect(() =>
      decodeComputerHostRequestV1("file/write", {
        ...request({
          kind: "file/write",
          path: "/home/box/notes.md",
          bytesBase64: "",
        }),
        mode: 0o10000,
      }),
    ).toThrow(/mode must be between/);
  });
});

describe("control, viewer, service, cancel", () => {
  test("round-trips a control acquisition", () => {
    const operation: ComputerHostOperationV1 = {
      kind: "control",
      action: "acquire",
      ownerId: "owner-1",
      maxAgeSeconds: 90,
    };
    expect(
      decodeComputerHostRequestV1("control", request(operation)).operation,
    ).toEqual(operation);
  });

  test("refuses an unknown control action", () => {
    expect(() =>
      decodeComputerHostRequestV1("control", {
        ...request({
          kind: "control",
          action: "acquire",
          ownerId: "owner-1",
          maxAgeSeconds: 90,
        }),
        action: "steal",
      }),
    ).toThrow(/control action is invalid/);
  });

  test("refuses a viewer revoke without a session", () => {
    expect(() =>
      decodeComputerHostRequestV1("viewer", {
        ...envelope,
        action: "revoke",
      }),
    ).toThrow(/revoke requires a session id/);
  });

  test("a cancel names its effect through the envelope alone", () => {
    const decoded = decodeComputerHostRequestV1(
      "cancel",
      request({ kind: "cancel" }),
    );
    expect(decoded.effectId).toBe("effect-1");
    expect(decoded.operation).toEqual({ kind: "cancel" });
  });

  test("round-trips a service reattachment", () => {
    expect(
      decodeComputerHostRequestV1(
        "service",
        request({ kind: "service", name: "frockbot-workspace-sync" }),
      ).operation,
    ).toEqual({ kind: "service", name: "frockbot-workspace-sync" });
  });
});

describe("HTTP decoding", () => {
  function post(path: string, body: unknown, method = "POST"): Request {
    return new Request(`http://computer-host.internal${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: method === "GET" ? undefined : JSON.stringify(body),
    });
  }

  test("decodes a well-formed request", async () => {
    const decoded = await decodeComputerHostHttpRequestV1(
      post(COMPUTER_HOST_ROUTES.open, request({ kind: "open" })),
    );
    expect(decoded.ok).toBe(true);
  });

  test("answers 404 for an unknown route", async () => {
    const decoded = await decodeComputerHostHttpRequestV1(
      post("/v1/computer/smoke", {}),
    );
    expect(decoded.ok).toBe(false);
    if (decoded.ok) throw new Error("expected a refusal");
    expect(decoded.response.status).toBe(404);
    expect(
      decodeComputerHostProblemV1(await decoded.response.json()).code,
    ).toBe("not-found");
  });

  test("answers 405 for the wrong method", async () => {
    const decoded = await decodeComputerHostHttpRequestV1(
      post(COMPUTER_HOST_ROUTES.open, undefined, "GET"),
    );
    if (decoded.ok) throw new Error("expected a refusal");
    expect(decoded.response.status).toBe(405);
  });

  test("answers 400 for a body that is not JSON", async () => {
    const decoded = await decodeComputerHostHttpRequestV1(
      new Request(`http://computer-host.internal${COMPUTER_HOST_ROUTES.open}`, {
        method: "POST",
        body: "{",
      }),
    );
    if (decoded.ok) throw new Error("expected a refusal");
    expect(decoded.response.status).toBe(400);
  });

  test("answers 413 for a request that exceeds a declared bound", async () => {
    const decoded = await decodeComputerHostHttpRequestV1(
      post(
        COMPUTER_HOST_ROUTES.exec,
        request({
          kind: "exec",
          script: "x".repeat(COMPUTER_HOST_LIMITS.script + 1),
          timeoutMs: 1_000,
          maxOutputBytes: 1_024,
          stream: false,
        }),
      ),
    );
    if (decoded.ok) throw new Error("expected a refusal");
    expect(decoded.response.status).toBe(413);
    expect(
      decodeComputerHostProblemV1(await decoded.response.json()).code,
    ).toBe("limit-exceeded");
  });
});

describe("results", () => {
  test("round-trips an open result", () => {
    const result = {
      version: 1 as const,
      effectId: "effect-1",
      spriteName: "frockbot-0123456789ab",
      directory: "agent-data/agents/bot-1",
      display: ":100",
      generation: 3,
    };
    expect(decodeComputerHostOpenResultV1(result)).toEqual(result);
  });

  test("distinguishes an in-place update from provisioning", () => {
    const provisioning = {
      kind: "update" as const,
      phase: "runtime",
      label: "Updating the Computer runtime",
      index: 1,
      total: 2,
      status: "running" as const,
      resumed: false,
    };
    expect(
      decodeComputerHostOpenResultV1({
        version: 1,
        effectId: "effect-1",
        spriteName: "frockbot-0123456789ab",
        directory: "agent-data/agents/bot-1",
        generation: 3,
        provisioning,
      }).provisioning,
    ).toEqual(provisioning);
  });

  test("round-trips an exec result", () => {
    const result = {
      version: 1 as const,
      effectId: "effect-1",
      exitCode: 0,
      stdoutBase64: btoa("out"),
      stderrBase64: "",
      outputTruncated: false,
    };
    expect(decodeComputerHostExecResultV1(result)).toEqual(result);
  });

  test("accepts a null exit code for a signalled command", () => {
    expect(
      decodeComputerHostExecResultV1({
        version: 1,
        effectId: "effect-1",
        exitCode: null,
        signal: "SIGTERM",
        stdoutBase64: "",
        stderrBase64: "",
        outputTruncated: true,
      }).signal,
    ).toBe("SIGTERM");
  });

  test("round-trips the file results", () => {
    const entry = {
      path: "/home/box/notes.md",
      kind: "file" as const,
      size: 5,
      mode: 0o644,
      modifiedAt: "2026-08-31T00:00:00.000Z",
    };
    expect(
      decodeComputerHostFileReadResultV1({
        version: 1,
        effectId: "effect-1",
        entry,
        bytesBase64: btoa("hello"),
      }).entry,
    ).toEqual(entry);
    expect(
      decodeComputerHostFileStatResultV1({
        version: 1,
        effectId: "effect-1",
        entry,
      }).entry,
    ).toEqual(entry);
    expect(
      decodeComputerHostFileWriteResultV1({
        version: 1,
        effectId: "effect-1",
        entry,
      }).entry,
    ).toEqual(entry);
    expect(
      decodeComputerHostFileListResultV1({
        version: 1,
        effectId: "effect-1",
        entries: [entry],
        truncated: false,
      }).entries,
    ).toEqual([entry]);
    expect(
      decodeComputerHostFileDeleteResultV1({
        version: 1,
        effectId: "effect-1",
        path: entry.path,
        deleted: true,
      }).deleted,
    ).toBe(true);
  });

  test("round-trips control, viewer, service, and cancel results", () => {
    expect(
      decodeComputerHostControlResultV1({
        version: 1,
        effectId: "effect-1",
        action: "acquire",
        ownerId: "owner-1",
        expiresAt: "2026-08-31T00:01:30.000Z",
      }).action,
    ).toBe("acquire");
    expect(
      decodeComputerHostViewerResultV1({
        version: 1,
        effectId: "effect-1",
        session: { id: "session-1", url: "https://example.invalid/vnc.html" },
      }).session?.id,
    ).toBe("session-1");
    expect(
      decodeComputerHostViewerResultV1({ version: 1, effectId: "effect-1" })
        .session,
    ).toBeUndefined();
    expect(
      decodeComputerHostServiceResultV1({
        version: 1,
        effectId: "effect-1",
        name: "frockbot-viewer-gateway",
        status: "running",
      }).status,
    ).toBe("running");
    expect(
      decodeComputerHostCancelResultV1({
        version: 1,
        effectId: "effect-1",
        cancelled: false,
      }).cancelled,
    ).toBe(false);
  });

  test("refuses a result carrying an undeclared field", () => {
    expect(() =>
      decodeComputerHostCancelResultV1({
        version: 1,
        effectId: "effect-1",
        cancelled: true,
        spritesToken: "leaked",
      }),
    ).toThrow(/unknown field/);
  });
});

describe("problems", () => {
  test("computer-updating is retryable by default", () => {
    expect(
      computerHostProblemV1("computer-updating", "Updating runtime"),
    ).toMatchObject({ code: "computer-updating", retryable: true });
  });

  test("problem() answers the declared shape", async () => {
    const response = problem(
      503,
      "provider-unavailable",
      "container restarted",
    );
    expect(response.status).toBe(503);
    const decoded = decodeComputerHostProblemV1(await response.json());
    expect(decoded).toEqual({
      version: 1,
      code: "provider-unavailable",
      message: "container restarted",
      retryable: true,
    });
  });

  test("a message longer than the bound is clipped rather than refused", () => {
    expect(
      computerHostProblemV1("provider-failure", "x".repeat(10_000)).message
        .length,
    ).toBe(COMPUTER_HOST_LIMITS.message);
  });

  test("refuses an unknown problem code", () => {
    expect(() =>
      decodeComputerHostProblemV1({
        version: 1,
        code: "kaboom",
        message: "no",
        retryable: false,
      }),
    ).toThrow(/code is invalid/);
  });
});

describe("exec frames", () => {
  test("round-trips every frame type", () => {
    const frames = [
      { type: "stdout" as const, dataBase64: btoa("out") },
      { type: "stderr" as const, dataBase64: btoa("err") },
      { type: "exit" as const, exitCode: 0, outputTruncated: false },
      {
        type: "exit" as const,
        exitCode: null,
        signal: "SIGTERM",
        outputTruncated: true,
      },
      {
        type: "error" as const,
        code: "limit-exceeded" as const,
        message: "too many",
        retryable: true,
      },
    ];
    for (const frame of frames) {
      expect(
        decodeComputerHostExecFrameV1(
          encodeComputerHostExecFrameV1(frame).trimEnd(),
        ),
      ).toEqual(frame);
    }
  });

  test("refuses an unknown frame type", () => {
    expect(() => decodeComputerHostExecFrameV1('{"type":"log"}')).toThrow(
      /frame type is invalid/,
    );
  });

  test("reassembles frames across arbitrary chunk boundaries", () => {
    const frames = [
      { type: "stdout" as const, dataBase64: btoa("one") },
      { type: "stderr" as const, dataBase64: btoa("two") },
      { type: "exit" as const, exitCode: 0, outputTruncated: false },
    ];
    const wire = frames.map(encodeComputerHostExecFrameV1).join("");
    for (const size of [1, 2, 3, 7, 13, 64, wire.length]) {
      const reader = new ComputerHostExecFrameReaderV1();
      const seen = [];
      for (let index = 0; index < wire.length; index += size) {
        seen.push(...reader.push(wire.slice(index, index + size)));
      }
      seen.push(...reader.end());
      expect(seen).toEqual(frames);
    }
  });

  test("reassembles a stream whose last frame has no trailing newline", () => {
    const reader = new ComputerHostExecFrameReaderV1();
    expect(
      reader.push('{"type":"exit","exitCode":0,"outputTruncated":false}'),
    ).toEqual([]);
    expect(reader.end()).toEqual([
      { type: "exit", exitCode: 0, outputTruncated: false },
    ]);
  });

  test("reassembles when a whole frame arrives inside one coalesced chunk", () => {
    const reader = new ComputerHostExecFrameReaderV1();
    const wire = [
      { type: "stdout" as const, dataBase64: btoa("a") },
      { type: "stdout" as const, dataBase64: btoa("b") },
    ]
      .map(encodeComputerHostExecFrameV1)
      .join("");
    expect(reader.push(new TextEncoder().encode(wire))).toHaveLength(2);
  });
});

describe("base64 fields", () => {
  test("accepts an empty payload", () => {
    expect(decodeBase64FieldV1("", "payload")).toBe("");
  });

  test("refuses a payload beyond its bound", () => {
    expect(() => decodeBase64FieldV1("AAAA", "payload", 2)).toThrow(
      /exceeds 2 encoded bytes/,
    );
  });
});
