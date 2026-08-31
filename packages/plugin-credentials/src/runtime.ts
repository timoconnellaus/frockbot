import {
  decodeCredentialLeaseV1,
  type CredentialLeaseV1,
  openCredentialV1,
  parseCredentialKeyringV1,
} from "@frockbot/connection-core";
import { type Context, type Plugin, Service } from "cordis";

export interface CredentialLeaseOpenRequest {
  accountId: string;
  connectionId: string;
  packageId: string;
  lease: CredentialLeaseV1;
}

export interface CredentialRuntimeConfig {
  readSecret(name: "CREDENTIAL_KEYRING"): string | undefined;
}

export class CredentialLeaseRuntime extends Service {
  private readonly keyring;

  constructor(ctx: Context, config: CredentialRuntimeConfig) {
    super(ctx, "credentialLease");
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

export function createCredentialRuntimePlugin(
  config: CredentialRuntimeConfig,
): Plugin.Function {
  return (ctx) => {
    new CredentialLeaseRuntime(ctx, config);
  };
}

export default createCredentialRuntimePlugin;
