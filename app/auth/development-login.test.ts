import { describe, expect, test } from "bun:test";
import {
  developmentLoginUrl,
  developmentUserFromUrl,
  isLoopbackHost,
} from "./client/development-login";

describe("development login", () => {
  test("is available only on loopback hosts", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("frockbot.example.com")).toBe(false);
  });

  test("recognizes only the fixed development identity", () => {
    expect(
      developmentUserFromUrl(
        new URL("http://localhost:5173/?as_user=development"),
      ),
    ).toBe("development");
    expect(
      developmentUserFromUrl(new URL("http://localhost:5173/?as_user=alice")),
    ).toBeUndefined();
    expect(
      developmentUserFromUrl(
        new URL("https://frockbot.example.com/?as_user=development"),
      ),
    ).toBeUndefined();
  });

  test("builds a login URL without dropping existing state", () => {
    expect(
      developmentLoginUrl(new URL("http://localhost:5173/?bot=demo#chat")),
    ).toBe("http://localhost:5173/?bot=demo&as_user=development#chat");
  });
});
