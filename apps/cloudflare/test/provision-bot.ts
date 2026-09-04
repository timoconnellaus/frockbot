// The production bootstrap for a Bot that can run a Turn, shared by every
// workerd suite that needs one. It is the product's own path: the User
// enables custom models, installs the provider Package, creates its Connection,
// chooses the account model, and only then creates the Bot.
import { env } from "cloudflare:workers";
import { expect } from "vitest";

/** The provider, model, and Package the bootstrap enables account-wide. */
export const PROVISIONED_MODEL = {
  packageId: "provider-ollama-cloud",
  connectionTypeId: "ollama-cloud-account",
  capabilityId: "ollama-cloud-models",
  provider: "ollama-cloud",
  providerModelId: "glm-5.3-flash:cloud",
} as const;

function user(name: string) {
  return env.USER_CONFIGURATIONS.getByName(name);
}

/**
 * A Bot receives model authority through account-wide Package and Connection
 * enablement, so this is the shortest path that is still the product's own.
 */
export async function provisionBot(
  identity: {
    userId: string;
    botId: string;
  },
  /**
   * The Connection's key. Defaults to the one the Ollama Cloud stub accepts; a
   * suite that needs the provider to refuse passes the revoked one.
   */
  apiKey = "workerd-test-key",
): Promise<void> {
  const configuration = user(identity.userId);
  const suffix = identity.botId;
  // SAFETY: the generated stub type for `readConfiguration` is too deep for the
  // compiler to instantiate here; this names the one field the bootstrap reads.
  const settingsRpc = configuration as unknown as {
    readConfiguration(input: unknown): Promise<{ revision: number }>;
  };
  const revision = async (): Promise<number> =>
    (
      await settingsRpc.readConfiguration({
        schemaVersion: 1,
        userId: identity.userId,
      })
    ).revision;
  // Custom models is seeded disabled for every User on first read; the product
  // path is to switch it on, not to install it, and the seed owns the revision.
  const seeded = await revision();
  await configuration.executeConfiguration({
    schemaVersion: 1,
    userId: identity.userId,
    command: {
      schemaVersion: 1,
      type: "user/set-package-enabled",
      commandId: `enable-custom-models-${suffix}`,
      expectedRevision: seeded,
      packageId: "custom-models",
      enabled: true,
    },
  });
  await configuration.executeConfiguration({
    schemaVersion: 1,
    userId: identity.userId,
    command: {
      schemaVersion: 1,
      type: "user/install-package",
      commandId: `install-${suffix}`,
      expectedRevision: seeded + 1,
      packageId: "provider-ollama-cloud",
      version: "0.0.1",
    },
  });
  const connection = (await configuration.executeConnection({
    schemaVersion: 1,
    userId: identity.userId,
    command: {
      schemaVersion: 1,
      type: "connection/create-api-key",
      commandId: `connect-${suffix}`,
      packageId: "provider-ollama-cloud",
      connectionTypeId: "ollama-cloud-account",
      label: "Workerd",
      apiKey,
    },
  })) as unknown as { status: string; connectionId: string };
  expect(connection).toMatchObject({ status: "applied" });
  await configuration.executeConfiguration({
    schemaVersion: 1,
    userId: identity.userId,
    command: {
      schemaVersion: 1,
      type: "user/set-package-settings",
      commandId: `model-${suffix}`,
      expectedRevision: await revision(),
      packageId: "custom-models",
      values: {
        "account-model": {
          connectionId: connection.connectionId,
          providerModelId: "glm-5.3-flash:cloud",
        },
      },
    },
  });
  await configuration.createBot({
    schemaVersion: 1,
    userId: identity.userId,
    command: {
      schemaVersion: 1,
      type: "bot/create",
      commandId: `create-${suffix}`,
      // The Flock keeps its own revision; a new User's is zero.
      expectedRevision: 0,
      botId: identity.botId,
      name: "Workerd Bot",
    },
  });
}

/**
 * A second Bot for a User whose Packages, Connection and account model
 * `provisionBot` already set up. Only `bot/create` is left, and the Flock's
 * revision has moved on by one Bot.
 */
export async function provisionSiblingBot(
  identity: { userId: string; botId: string },
  expectedRevision: number,
): Promise<void> {
  await user(identity.userId).createBot({
    schemaVersion: 1,
    userId: identity.userId,
    command: {
      schemaVersion: 1,
      type: "bot/create",
      commandId: `create-${identity.botId}`,
      expectedRevision,
      botId: identity.botId,
      name: "Workerd Sibling",
    },
  });
}
