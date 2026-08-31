import { describe, expect, test } from "bun:test";
import {
  parseCredentialKeyringV1,
  sealCredentialV1,
} from "@frockbot/connection-core";
import { Context } from "cordis";
import {
  createCredentialRuntimePlugin,
  type CredentialLeaseRuntime,
} from "./runtime.js";

const serializedKeyring =
  '{"schemaVersion":1,"currentKeyId":"primary","keys":{"primary":"MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY"}}';

describe("Credential runtime Contribution", () => {
  test("opens an opaque lease only for its exact authority", async () => {
    const envelope = await sealCredentialV1({
      keyring: parseCredentialKeyringV1(serializedKeyring),
      context: {
        accountId: "account-1",
        connectionId: "connection-1",
        packageId: "provider-ollama-cloud",
        credentialGeneration: "generation-1",
      },
      plaintext: "secret",
    });
    const lease = {
      schemaVersion: 1 as const,
      leaseId: "lease-1",
      effectId: "effect-1",
      connectionId: "connection-1",
      credentialGeneration: "generation-1",
      expiresAt: "2099-01-01T00:00:00.000Z",
      envelope,
    };
    const root = new Context();
    await root.plugin(
      createCredentialRuntimePlugin({
        readSecret: () => serializedKeyring,
      }),
    );

    const credentialLease = (
      root as Context & { credentialLease: CredentialLeaseRuntime }
    ).credentialLease;
    await expect(
      credentialLease.open({
        accountId: "account-1",
        connectionId: "connection-1",
        packageId: "provider-ollama-cloud",
        lease,
      }),
    ).resolves.toBe("secret");
    await expect(
      credentialLease.open({
        accountId: "another-account",
        connectionId: "connection-1",
        packageId: "provider-ollama-cloud",
        lease,
      }),
    ).rejects.toThrow();
    await root.fiber.dispose();
  });
});
