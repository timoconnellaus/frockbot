import { expect, test } from "bun:test";
import { CLIENT_COMPATIBILITY } from "@frockbot/protocol-schemas";
import {
  CLIENT_HELLO_HEADER,
  UPDATE_APP_MESSAGE,
  clientCompatibilityResponse,
} from "./client-compatibility.ts";

const hello = {
  schemaVersion: 1,
  protocolVersion: 1,
  nativeVersion: "1.1.0",
  catalogs: [],
};
function check(value: unknown, path = "/api/bots/default/turns") {
  const request = new Request(`https://bot.example${path}`, {
    headers: {
      [CLIENT_HELLO_HEADER]:
        typeof value === "string" ? value : JSON.stringify(value),
    },
  });
  return clientCompatibilityResponse(request, new URL(request.url));
}
test("compatible clients continue and catalogs do not confer authority", () => {
  for (const version of ["1.1.0", "1.2.0", "2.0.0", "1.10.0"])
    expect(check({ ...hello, nativeVersion: version })).toBeUndefined();
  expect(
    check({ ...hello, catalogs: [{ id: "unknown", digest: "a".repeat(64) }] }),
  ).toBeUndefined();
});
test("unsupported or malformed clients get plain update copy before routing", async () => {
  for (const value of [
    { ...hello, nativeVersion: "1.0.9" },
    { ...hello, nativeVersion: "1.1" },
    { ...hello, protocolVersion: 2 },
    { ...hello, protocolVersion: 0 },
    { ...hello, nativeVersion: "99999999999999999.0.0" },
    "{",
    "x".repeat(4097),
    {},
  ]) {
    const response = check(value)!;
    expect(response.status).toBe(426);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe(UPDATE_APP_MESSAGE);
  }
});
test("legacy browser requests continue; native auth cannot omit negotiation", () => {
  for (const path of ["/api/native/turns", "/api/auth/native/exchange"]) {
    const request = new Request(`https://bot.example${path}`);
    expect(
      clientCompatibilityResponse(request, new URL(request.url))?.status,
    ).toBe(426);
  }
  const request = new Request("https://bot.example/api/identity");
  expect(
    clientCompatibilityResponse(request, new URL(request.url)),
  ).toBeUndefined();
});
test("discovery publishes the generated compatibility policy without caching", async () => {
  const request = new Request("https://bot.example/api/client-compatibility");
  const response = clientCompatibilityResponse(request, new URL(request.url))!;
  expect<unknown>(await response.json()).toEqual(CLIENT_COMPATIBILITY);
});
