import { expect, test } from "bun:test";
import { saveNativeQualificationForm } from "./native-form.js";
import type { NativeSessionStorage } from "./native-sessions.js";
test("qualification form persists once and refuses stale, changed, cross-User and undeclared actions", () => {
  const data = new Map<string, unknown>();
  let writes = 0;
  const storage: NativeSessionStorage = {
    get: <T>(key: string) => data.get(key) as T | undefined,
    put: (key, value) => {
      writes++;
      data.set(key, structuredClone(value));
    },
  };
  const command = {
    schemaVersion: 1,
    commandId: "save-1",
    surfaceId: "qualification",
    revision: 1,
    input: { name: "Pixel" },
  };
  const receipt = saveNativeQualificationForm(storage, "user-1", command);
  expect(
    saveNativeQualificationForm(storage, "user-1", structuredClone(command)),
  ).toEqual(receipt);
  expect(writes).toBe(1);
  for (const bad of [
    { ...command, revision: 2 },
    { ...command, input: { name: "changed" } },
    { ...command, input: { name: "Pixel", password: "no" } },
    { ...command, surfaceId: "other" },
  ])
    expect(() => saveNativeQualificationForm(storage, "user-1", bad)).toThrow();
  expect(() =>
    saveNativeQualificationForm(storage, "user-2", command),
  ).toThrow();
  expect(writes).toBe(1);
});
