import { describe, expect, test } from "bun:test";
import { rpcJsonSnapshotV1, rpcRecordV1 } from "./durable-rpc.js";

describe("Durable RPC boundary primitives", () => {
  test("snapshots the JSON DTO without runtime-owned properties", () => {
    const runtimeProperty = Symbol("runtime");
    const value = {
      nested: { enabled: true },
      [runtimeProperty]: "not wire data",
    };

    const snapshot = rpcJsonSnapshotV1(value);

    expect(snapshot as unknown).toEqual({ nested: { enabled: true } });
    expect(snapshot).not.toBe(value);
    expect(snapshot.nested).not.toBe(value.nested);
  });

  test("rejects values that JSON cannot represent", () => {
    expect(() => rpcJsonSnapshotV1(undefined)).toThrow(
      "RPC response is not a JSON value",
    );

    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(() => rpcJsonSnapshotV1(circular)).toThrow(
      "RPC response is not valid JSON",
    );
  });

  test("accepts records and rejects other JSON containers", () => {
    expect(rpcRecordV1({ value: 1 })).toEqual({ value: 1 });
    expect(() => rpcRecordV1(null, "answer")).toThrow(
      "answer must be an object",
    );
    expect(() => rpcRecordV1([], "answer")).toThrow("answer must be an object");
  });
});
