import { describe, expect, test } from "bun:test";
import {
  decodeSecretSubmitCommandV1,
  looksLikePaymentCardV1,
  paymentFieldV1,
  secretOriginV1,
  secretRequestIdV1,
  withoutSecretV1,
} from "./shared.js";

describe("the terms a secret is asked and filled under", () => {
  test("a site is named by its https origin", () => {
    expect(secretOriginV1("https://shop.example/account/login?next=/")).toBe(
      "https://shop.example",
    );
    expect(secretOriginV1("http://127.0.0.1:8944/")).toBe(
      "http://127.0.0.1:8944",
    );
    expect(() => secretOriginV1("http://shop.example")).toThrow("https");
    expect(() => secretOriginV1("https://me:pw@shop.example")).toThrow();
    expect(() => secretOriginV1("shop.example")).toThrow();
  });

  test("a card number is told by its digits, not by its label", () => {
    expect(looksLikePaymentCardV1("4242 4242 4242 4242")).toBe(true);
    expect(looksLikePaymentCardV1("4242-4242-4242-4241")).toBe(false);
    expect(looksLikePaymentCardV1("hunter2")).toBe(false);
    expect(paymentFieldV1("Card number")).toBe(true);
    expect(paymentFieldV1("CVC")).toBe(true);
    expect(paymentFieldV1("IBAN")).toBe(true);
    expect(paymentFieldV1("Password")).toBe(false);
    expect(paymentFieldV1("Email")).toBe(false);
  });

  test("a request's id is stable for one effect and unguessable without the Bot's secret", async () => {
    const one = await secretRequestIdV1("bot-secret", "s", "tool:1:1:0");
    expect(one).toMatch(/^secret-request-[0-9a-f]{32}$/);
    expect(await secretRequestIdV1("bot-secret", "s", "tool:1:1:0")).toBe(one);
    expect(await secretRequestIdV1("other", "s", "tool:1:1:0")).not.toBe(one);
  });

  test("a typed value is never repeated in a refusal", () => {
    const value = "x".repeat(5_000);
    const refusals = [
      () =>
        decodeSecretSubmitCommandV1({
          schemaVersion: 1,
          commandId: "c-1",
          value,
        }),
      () =>
        decodeSecretSubmitCommandV1({
          schemaVersion: 1,
          commandId: "bad id!",
          value: "hunter2",
        }),
      () =>
        decodeSecretSubmitCommandV1({
          schemaVersion: 1,
          commandId: "c-1",
          value: "hunter2",
          extra: "hunter2",
        }),
    ];
    for (const refuse of refusals) {
      let message = "";
      try {
        refuse();
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toBe("");
      expect(message).not.toContain("hunter2");
      expect(message).not.toContain(value);
    }
    expect(withoutSecretV1("typed hunter2 twice: hunter2", "hunter2")).toBe(
      "typed [secret] twice: [secret]",
    );
  });
});
