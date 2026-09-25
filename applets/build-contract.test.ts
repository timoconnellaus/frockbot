import { describe, expect, test } from "bun:test";

import {
  APPLET_BUILD_TOKEN_HEADER,
  PLUGIN_BUILD_LIMITS,
  PLUGIN_BUILD_ROUTE,
  PluginBuildDecodeError,
  decodePluginBuildHttpRequestV1,
  decodePluginBuildManifestV1,
  decodePluginBuildProblemV1,
  decodePluginBuildRequestV1,
  decodePluginBuildResponseV1,
  decodePluginSourcePathV1,
  encodePluginBuildRequestV1,
  encodePluginBuildResponseV1,
  isPluginBuiltResponseV1,
  pluginBuildProblemResponseV1,
  type PluginBuildRequestV1,
  type PluginBuildResponseV1,
} from "./build-contract.ts";

const PLUGIN_ID = "weather";

function request(
  overrides: Partial<PluginBuildRequestV1> = {},
): PluginBuildRequestV1 {
  return {
    version: 1,
    effectId: "effect-1",
    id: PLUGIN_ID,
    mode: "build",
    files: [
      { path: "plugin.json", text: "{}" },
      { path: "plugin.ts", text: "export const tools = [];\n" },
    ],
    ...overrides,
  };
}

const MANIFEST = {
  contract: 1 as const,
  tools: [
    {
      name: "forecast",
      description: "Read a forecast.",
      inputSchema: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
        additionalProperties: false,
      },
    },
  ],
  hooks: ["agent/tool-exposure" as const],
  services: ["weather-lookup"],
  triggers: ["weather_alert"],
  views: ["weather.settings"],
  cards: ["draft"],
  modelProviders: ["weather"],
  modules: [{ id: "bridge", calls: ["search", "send"], hash: "c".repeat(64) }],
  hashes: { module: "b".repeat(64) },
};

describe("the Plugin build request", () => {
  test("round-trips through its encoder and decoder", () => {
    const original = request();
    expect(
      decodePluginBuildRequestV1(encodePluginBuildRequestV1(original)),
    ).toEqual(original);
  });

  test("refuses a field the schema does not declare", () => {
    expect(() =>
      decodePluginBuildRequestV1({
        ...encodePluginBuildRequestV1(request()),
        kind: "plugin",
      }),
    ).toThrow(/unknown field: kind/);
  });

  test("refuses another protocol version", () => {
    expect(() =>
      decodePluginBuildRequestV1({
        ...encodePluginBuildRequestV1(request()),
        version: 2,
      }),
    ).toThrow(/version is not 1/);
  });

  test("refuses an id a Plugin descriptor would not admit", () => {
    for (const id of ["Weather", "owner.weather", "x".repeat(65)]) {
      expect(() =>
        decodePluginBuildRequestV1(encodePluginBuildRequestV1(request({ id }))),
      ).toThrow(/Plugin build id/);
    }
  });

  test("refuses a mode it does not serve", () => {
    expect(() =>
      decodePluginBuildRequestV1({
        ...encodePluginBuildRequestV1(request()),
        mode: "publish",
      }),
    ).toThrow(/mode must be check or build/);
  });

  test("refuses an empty file list and a repeated path", () => {
    expect(() =>
      decodePluginBuildRequestV1({
        ...encodePluginBuildRequestV1(request()),
        files: [],
      }),
    ).toThrow(/must not be empty/);
    expect(() =>
      decodePluginBuildRequestV1({
        ...encodePluginBuildRequestV1(request()),
        files: [
          { path: "plugin.ts", text: "" },
          { path: "plugin.ts", text: "" },
        ],
      }),
    ).toThrow(/repeat plugin.ts/);
  });

  test("refuses source that escapes the build directory", () => {
    for (const path of [
      "/etc/passwd",
      "../plugin.ts",
      "a//b.ts",
      "a\\b.ts",
      "src/",
    ]) {
      expect(() => decodePluginSourcePathV1(path)).toThrow(
        /relative and normalized/,
      );
    }
    expect(decodePluginSourcePathV1("lib/dates.ts")).toBe("lib/dates.ts");
  });

  test("refuses source past the total ceiling", () => {
    const text = "x".repeat(PLUGIN_BUILD_LIMITS.fileText);
    expect(() =>
      decodePluginBuildRequestV1({
        ...encodePluginBuildRequestV1(request()),
        files: Array.from({ length: 4 }, (_, index) => ({
          path: `file-${index}.ts`,
          text,
        })),
      }),
    ).toThrow(/Plugin source exceeds/);
  });
});

describe("the Plugin build HTTP seam", () => {
  function post(body: unknown, path = PLUGIN_BUILD_ROUTE): Request {
    return new Request(`http://applet-build.internal${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  test("decodes a well-formed post", async () => {
    const decoded = await decodePluginBuildHttpRequestV1(
      post(encodePluginBuildRequestV1(request())),
    );
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.value.id).toBe(PLUGIN_ID);
  });

  test("answers a problem, never an exception", async () => {
    const cases: [Request, number][] = [
      [post({}, "/nope"), 404],
      [new Request(`http://applet-build.internal${PLUGIN_BUILD_ROUTE}`), 405],
      [post({ version: 1 }), 400],
    ];
    for (const [inbound, status] of cases) {
      const decoded = await decodePluginBuildHttpRequestV1(inbound);
      expect(decoded.ok).toBe(false);
      if (!decoded.ok) expect(decoded.response.status).toBe(status);
    }
  });

  test("refuses a body over the ceiling with 413", async () => {
    const oversize = await decodePluginBuildHttpRequestV1(
      post({ padding: "x".repeat(PLUGIN_BUILD_LIMITS.requestBytes + 1) }),
    );
    expect(oversize.ok).toBe(false);
    if (!oversize.ok) expect(oversize.response.status).toBe(413);
  });
});

describe("the Plugin build response", () => {
  test("round-trips a built module and its manifest", () => {
    const response = {
      status: "built" as const,
      manifest: MANIFEST,
      module: "export const tools = [];\n",
      modules: [{ id: "bridge", code: "export const calls = {};\n" }],
    };
    const decoded = decodePluginBuildResponseV1(
      encodePluginBuildResponseV1(response),
    );
    expect(decoded).toEqual(response);
    expect(isPluginBuiltResponseV1(decoded)).toBe(true);
  });

  test("refuses device module code the manifest does not declare", () => {
    expect(() =>
      decodePluginBuildResponseV1({
        status: "built",
        manifest: MANIFEST,
        module: "x",
        modules: [],
      }),
    ).toThrow(/one artifact per declared module/);
    expect(() =>
      decodePluginBuildResponseV1({
        status: "built",
        manifest: MANIFEST,
        module: "x",
        modules: [{ id: "other", code: "" }],
      }),
    ).toThrow(/not the module the manifest declares/);
  });

  test("round-trips a passing check, which carries no module", () => {
    const checked: PluginBuildResponseV1 = { status: "built" };
    const decoded = decodePluginBuildResponseV1(
      encodePluginBuildResponseV1(checked),
    );
    expect(decoded).toEqual(checked);
    expect(isPluginBuiltResponseV1(decoded)).toBe(false);
  });

  test("refuses a built response that carries half an artifact", () => {
    expect(() =>
      decodePluginBuildResponseV1({ status: "built", manifest: MANIFEST }),
    ).toThrow(/module artifact must be a string/);
    expect(() =>
      decodePluginBuildResponseV1({
        status: "built",
        manifest: MANIFEST,
        module: "",
        server: "",
      }),
    ).toThrow(/unknown field: server/);
  });

  test("round-trips a failure and its stage", () => {
    const failed: PluginBuildResponseV1 = {
      status: "failed",
      stage: "typecheck",
      diagnostics: [
        {
          file: "plugin.ts",
          line: 4,
          column: 11,
          message: "Type 'string' is not assignable to type 'number'. (TS2322)",
          severity: "error",
        },
      ],
    };
    expect(
      decodePluginBuildResponseV1(encodePluginBuildResponseV1(failed)),
    ).toEqual(failed);
  });

  test("refuses a stage it does not name", () => {
    for (const stage of ["deploy", "lint"]) {
      expect(() =>
        decodePluginBuildResponseV1({
          status: "failed",
          stage,
          diagnostics: [],
        }),
      ).toThrow(/stage is invalid/);
    }
  });

  test("refuses a module hash that is not a digest", () => {
    expect(() =>
      decodePluginBuildManifestV1({
        ...MANIFEST,
        hashes: { module: "short" },
      }),
    ).toThrow(/not a sha256 digest/);
  });

  test("refuses a tool name the kernel would not admit", () => {
    expect(() =>
      decodePluginBuildManifestV1({
        ...MANIFEST,
        tools: [{ ...MANIFEST.tools[0]!, name: "Read-Forecast" }],
      }),
    ).toThrow(/name is invalid/);
  });

  test("refuses a hook the contract does not serve, and a repeated one", () => {
    expect(() =>
      decodePluginBuildManifestV1({ ...MANIFEST, hooks: ["agent/created"] }),
    ).toThrow(/hook this contract does not serve/);
    expect(() =>
      decodePluginBuildManifestV1({
        ...MANIFEST,
        hooks: ["agent/request", "agent/request"],
      }),
    ).toThrow(/repeats a hook/);
  });

  test("refuses a service or trigger name the descriptor would not admit", () => {
    expect(() =>
      decodePluginBuildManifestV1({ ...MANIFEST, services: ["Weather"] }),
    ).toThrow(/services\[0\] is invalid/);
    expect(() =>
      decodePluginBuildManifestV1({ ...MANIFEST, triggers: ["a b"] }),
    ).toThrow(/triggers\[0\] is invalid/);
    expect(() =>
      decodePluginBuildManifestV1({ ...MANIFEST, views: ["bad surface"] }),
    ).toThrow(/views\[0\] is invalid/);
  });

  test("refuses a module past its ceiling with the limit-exceeded code", () => {
    try {
      decodePluginBuildResponseV1({
        status: "built",
        manifest: MANIFEST,
        module: "x".repeat(PLUGIN_BUILD_LIMITS.moduleBytes + 1),
      });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(PluginBuildDecodeError);
      expect((error as PluginBuildDecodeError).code).toBe("limit-exceeded");
    }
  });
});

describe("the Plugin build problem", () => {
  test("round-trips, and marks a transient code retryable", async () => {
    const response = pluginBuildProblemResponseV1(
      413,
      "limit-exceeded",
      "request body too large",
    );
    const problem = decodePluginBuildProblemV1(await response.json());
    expect(problem).toEqual({
      version: 1,
      code: "limit-exceeded",
      message: "request body too large",
      retryable: true,
    });
  });

  test("does not mark a caller's own mistake retryable", async () => {
    const response = pluginBuildProblemResponseV1(
      401,
      "not-authorized",
      "Plugin build token is missing or wrong",
    );
    expect(decodePluginBuildProblemV1(await response.json()).retryable).toBe(
      false,
    );
  });

  test("names the token header both sides check", () => {
    expect(APPLET_BUILD_TOKEN_HEADER).toBe("x-frockbot-applet-build-token");
  });
});
