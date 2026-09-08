import { describe, expect, test } from "bun:test";

import {
  APPLET_BUILD_LIMITS,
  APPLET_BUILD_ROUTE,
  APPLET_BUILD_TOKEN_HEADER,
  appletBuildProblemResponseV1,
  decodeAppletBuildHttpRequestV1,
  decodeAppletBuildManifestV1,
  decodeAppletBuildProblemV1,
  decodeAppletBuildRequestV1,
  decodeAppletBuildResponseV1,
  decodeAppletSourcePathV1,
  encodeAppletBuildRequestV1,
  encodeAppletBuildResponseV1,
  type AppletBuildRequestV1,
  type AppletBuildResponseV1,
} from "./build-contract.ts";

const APPLET_ID = "vgpqfaCcwnPlzjYdb2mI.weekly-todos";

function request(
  overrides: Partial<AppletBuildRequestV1> = {},
): AppletBuildRequestV1 {
  return {
    version: 1,
    effectId: "effect-1",
    appletId: APPLET_ID,
    mode: "build",
    files: [
      { path: "applet.json", text: "{}" },
      { path: "server.ts", text: "export default class {}\n" },
      { path: "ui.tsx", text: "export {};\n" },
    ],
    ...overrides,
  };
}

const MANIFEST = {
  contract: 1 as const,
  tools: [
    {
      name: "add_todo",
      description: "Add a todo.",
      inputSchema: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
        additionalProperties: false,
      },
    },
  ],
  hashes: { server: "a".repeat(64), ui: "b".repeat(64) },
};

describe("the Applet build request", () => {
  test("round-trips through its encoder and decoder", () => {
    const original = request();
    expect(
      decodeAppletBuildRequestV1(encodeAppletBuildRequestV1(original)),
    ).toEqual(original);
  });

  test("refuses a field the schema does not declare", () => {
    expect(() =>
      decodeAppletBuildRequestV1({
        ...encodeAppletBuildRequestV1(request()),
        extra: 1,
      }),
    ).toThrow(/unknown field/);
  });

  test("refuses another protocol version", () => {
    expect(() =>
      decodeAppletBuildRequestV1({
        ...encodeAppletBuildRequestV1(request()),
        version: 2,
      }),
    ).toThrow(/version is not 1/);
  });

  test("refuses an Applet id that is not `<owner>.<slug>`", () => {
    expect(() =>
      decodeAppletBuildRequestV1(
        encodeAppletBuildRequestV1(request({ appletId: "weekly-todos" })),
      ),
    ).toThrow(/applet id is invalid/);
  });

  test("refuses a mode it does not serve", () => {
    expect(() =>
      decodeAppletBuildRequestV1({
        ...encodeAppletBuildRequestV1(request()),
        mode: "publish",
      }),
    ).toThrow(/mode must be check or build/);
  });

  test("refuses an empty file list and a repeated path", () => {
    expect(() =>
      decodeAppletBuildRequestV1({
        ...encodeAppletBuildRequestV1(request()),
        files: [],
      }),
    ).toThrow(/must not be empty/);
    expect(() =>
      decodeAppletBuildRequestV1({
        ...encodeAppletBuildRequestV1(request()),
        files: [
          { path: "server.ts", text: "" },
          { path: "server.ts", text: "" },
        ],
      }),
    ).toThrow(/repeat server.ts/);
  });

  test("refuses source that escapes the build directory", () => {
    for (const path of [
      "/etc/passwd",
      "../server.ts",
      "a//b.ts",
      "a\\b.ts",
      "src/",
    ]) {
      expect(() => decodeAppletSourcePathV1(path)).toThrow(
        /relative and normalized/,
      );
    }
    expect(decodeAppletSourcePathV1("lib/dates.ts")).toBe("lib/dates.ts");
  });

  test("refuses source past the total ceiling", () => {
    const text = "x".repeat(APPLET_BUILD_LIMITS.fileText);
    expect(() =>
      decodeAppletBuildRequestV1({
        ...encodeAppletBuildRequestV1(request()),
        files: Array.from({ length: 4 }, (_, index) => ({
          path: `file-${index}.ts`,
          text,
        })),
      }),
    ).toThrow(/Applet source exceeds/);
  });
});

describe("the Applet build HTTP seam", () => {
  function post(body: unknown, path = APPLET_BUILD_ROUTE): Request {
    return new Request(`http://applet-build.internal${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  test("decodes a well-formed post", async () => {
    const decoded = await decodeAppletBuildHttpRequestV1(
      post(encodeAppletBuildRequestV1(request())),
    );
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.value.appletId).toBe(APPLET_ID);
  });

  test("answers a problem, never an exception", async () => {
    const cases: [Request, number][] = [
      [post({}, "/nope"), 404],
      [new Request(`http://applet-build.internal${APPLET_BUILD_ROUTE}`), 405],
      [post({ version: 1 }), 400],
    ];
    for (const [inbound, status] of cases) {
      const decoded = await decodeAppletBuildHttpRequestV1(inbound);
      expect(decoded.ok).toBe(false);
      if (!decoded.ok) expect(decoded.response.status).toBe(status);
    }
  });

  test("refuses a body over the ceiling with 413", async () => {
    const oversize = await decodeAppletBuildHttpRequestV1(
      post({ padding: "x".repeat(APPLET_BUILD_LIMITS.requestBytes + 1) }),
    );
    expect(oversize.ok).toBe(false);
    if (!oversize.ok) expect(oversize.response.status).toBe(413);
  });
});

describe("the Applet build response", () => {
  test("round-trips a built artifact", () => {
    const built: AppletBuildResponseV1 = {
      status: "built",
      manifest: MANIFEST,
      server: "export class Applet {}",
      ui: "<!doctype html>",
    };
    expect(
      decodeAppletBuildResponseV1(encodeAppletBuildResponseV1(built)),
    ).toEqual(built);
  });

  test("round-trips a passing check, which carries no artifact", () => {
    const checked: AppletBuildResponseV1 = { status: "built" };
    expect(
      decodeAppletBuildResponseV1(encodeAppletBuildResponseV1(checked)),
    ).toEqual(checked);
  });

  test("round-trips a failure and its stage", () => {
    const failed: AppletBuildResponseV1 = {
      status: "failed",
      stage: "typecheck",
      diagnostics: [
        {
          file: "server.ts",
          line: 4,
          column: 11,
          message: "Type 'string' is not assignable to type 'number'. (TS2322)",
          severity: "error",
        },
      ],
    };
    expect(
      decodeAppletBuildResponseV1(encodeAppletBuildResponseV1(failed)),
    ).toEqual(failed);
  });

  test("refuses a stage it does not name", () => {
    expect(() =>
      decodeAppletBuildResponseV1({
        status: "failed",
        stage: "deploy",
        diagnostics: [],
      }),
    ).toThrow(/stage is invalid/);
  });

  test("refuses a manifest hash that is not a digest", () => {
    expect(() =>
      decodeAppletBuildManifestV1({
        ...MANIFEST,
        hashes: { server: "short", ui: "b".repeat(64) },
      }),
    ).toThrow(/not a sha256 digest/);
  });

  test("refuses a tool name the kernel would not admit", () => {
    expect(() =>
      decodeAppletBuildManifestV1({
        ...MANIFEST,
        tools: [{ ...MANIFEST.tools[0]!, name: "Add-Todo" }],
      }),
    ).toThrow(/name is invalid/);
  });

  test("refuses an artifact past its ceiling with the limit-exceeded code", () => {
    expect(() =>
      decodeAppletBuildResponseV1({
        status: "built",
        manifest: MANIFEST,
        server: "x".repeat(APPLET_BUILD_LIMITS.serverBytes + 1),
        ui: "",
      }),
    ).toThrow(/server artifact exceeds/);
  });
});

describe("the Applet build problem", () => {
  test("round-trips, and marks a transient code retryable", async () => {
    const response = appletBuildProblemResponseV1(
      413,
      "limit-exceeded",
      "request body too large",
    );
    const problem = decodeAppletBuildProblemV1(await response.json());
    expect(problem).toEqual({
      version: 1,
      code: "limit-exceeded",
      message: "request body too large",
      retryable: true,
    });
  });

  test("does not mark a caller's own mistake retryable", async () => {
    const response = appletBuildProblemResponseV1(
      401,
      "not-authorized",
      "Applet build token is missing or wrong",
    );
    expect(decodeAppletBuildProblemV1(await response.json()).retryable).toBe(
      false,
    );
  });

  test("names the token header both sides check", () => {
    expect(APPLET_BUILD_TOKEN_HEADER).toBe("x-frockbot-applet-build-token");
  });
});
