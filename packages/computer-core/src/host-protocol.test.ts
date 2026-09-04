import { describe, expect, test } from "bun:test";
import {
  computerHostEffectRequestWireV1,
  computerHostEffectResponseWireV1,
  decodeComputerHostEffectRequestV1,
  decodeComputerHostEffectResponseV1,
  type ComputerHostEffectRequestV1,
} from "./host-protocol.js";

const request: ComputerHostEffectRequestV1 = {
  schemaVersion: 1,
  effectId: "tool:1:1:0",
  identity: { userId: "user-1" },
  tenant: { botId: "bot-1" },
  assignment: { providerId: "shared-computer", generation: 1 },
  operation: {
    type: "exec",
    request: {
      executable: "/bin/sh",
      args: ["-c", "printf hello"],
      stdin: Uint8Array.from([1, 2, 3]),
    },
  },
};

describe("Computer host protocol", () => {
  test("round-trips exact provider-neutral effects and binary results", () => {
    expect(
      decodeComputerHostEffectRequestV1(
        computerHostEffectRequestWireV1(request),
      ),
    ).toEqual(request);
    const response = decodeComputerHostEffectResponseV1(
      computerHostEffectResponseWireV1({
        schemaVersion: 1,
        effectId: request.effectId,
        status: "completed",
        result: {
          type: "exec",
          result: {
            exitCode: 0,
            stdout: Uint8Array.from([104, 105]),
            stderr: new Uint8Array(),
            outputTruncated: false,
          },
        },
      }),
    );
    expect(response).toMatchObject({
      status: "completed",
      result: { type: "exec", result: { stdout: Uint8Array.from([104, 105]) } },
    });
  });

  test("rejects hidden and symbol request fields", () => {
    const hidden = { ...computerHostEffectRequestWireV1(request) };
    Object.defineProperty(hidden, "secret", { value: true });
    const symbol = {
      ...computerHostEffectRequestWireV1(request),
      [Symbol("secret")]: true,
    };
    expect(() => decodeComputerHostEffectRequestV1(hidden)).toThrow(
      "unknown or missing fields",
    );
    expect(() => decodeComputerHostEffectRequestV1(symbol)).toThrow(
      "unknown or missing fields",
    );
  });

  test("round-trips the bounded internal browser origin cleanup", () => {
    const cleanup: ComputerHostEffectRequestV1 = {
      ...request,
      operation: {
        type: "browser",
        action: {
          type: "close-origins",
          origins: ["http://127.0.0.1:8787"],
        },
      },
    };
    expect(
      decodeComputerHostEffectRequestV1(
        computerHostEffectRequestWireV1(cleanup),
      ),
    ).toEqual(cleanup);
    expect(() =>
      decodeComputerHostEffectRequestV1({
        ...computerHostEffectRequestWireV1(cleanup),
        operation: {
          type: "browser",
          action: { type: "close-origins", origins: [] },
        },
      }),
    ).toThrow("origins are invalid");
  });
});
