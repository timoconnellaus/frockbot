import {
  decodeCredentialLeaseV1,
  type CredentialLeaseV1,
  openCredentialV1,
  parseCredentialKeyringV1,
} from "@frockbot/connection-core";
import type { RuntimeFeatureV1 } from "@frockbot/kernel-contracts";

export interface CredentialLeaseOpenRequest {
  accountId: string;
  connectionId: string;
  packageId: string;
  lease: CredentialLeaseV1;
}

export interface CredentialRuntimeConfig {
  readSecret(name: "CREDENTIAL_KEYRING"): string | undefined;
}

export class CredentialLeaseRuntime {
  private readonly keyring;

  constructor(config: CredentialRuntimeConfig) {
    const serialized = config.readSecret("CREDENTIAL_KEYRING");
    if (!serialized) {
      throw new Error("Credential Store Contribution is not configured");
    }
    this.keyring = parseCredentialKeyringV1(serialized);
  }

  open(input: CredentialLeaseOpenRequest): Promise<string> {
    const lease = decodeCredentialLeaseV1(input.lease);
    if (
      lease.connectionId !== input.connectionId ||
      lease.envelope.credentialGeneration !== lease.credentialGeneration
    ) {
      return Promise.reject(new Error("Credential lease authority is invalid"));
    }
    return openCredentialV1({
      keyring: this.keyring,
      context: {
        accountId: input.accountId,
        connectionId: input.connectionId,
        packageId: input.packageId,
        credentialGeneration: lease.credentialGeneration,
      },
      envelope: lease.envelope,
    });
  }
}

/** Opens the User's credential leases to every feature mounted after it. */
export function createCredentialsFeature(
  config: CredentialRuntimeConfig,
): RuntimeFeatureV1<{ credentials?: CredentialLeaseRuntime }> {
  return (runtime) => {
    runtime.credentials = new CredentialLeaseRuntime(config);
  };
}
