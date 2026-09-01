// The external Channel connector against real workerd storage and a real
// credential keyring.
//
// `ChannelConnectorService` and the Telegram connector are unit-tested over
// plain objects, which proves their rules. This proves the property a plain
// object cannot: that the bot token reaches Telegram *only* by being sealed by
// the Credential Store, leased, and opened inside the Durable Object — and that
// nothing durable in this object ever holds it in the clear.
//
// It is a probe, not production: the production User Durable Object composes
// the very same `ChannelStore`, `ChannelConnectorService` and connector over
// the same `ctx.storage`, and this one exists so a test can drive the connector
// without provisioning a whole User, a Bot and a Connection projection.
import { DurableObject } from "cloudflare:workers";
import { ChannelStore } from "@frockbot/plugin-channels/store";
import { ChannelConnectorService } from "@frockbot/plugin-channels/connect";
import { channelTokenSecretV1 } from "@frockbot/plugin-channels/token";
import type { ChannelOutboundReceiptV1 } from "@frockbot/plugin-channels/connector";
import {
  createTelegramConnectorV1,
  TELEGRAM_PLATFORM_V1,
} from "@frockbot/plugin-telegram/connector";
import {
  CredentialUserBackendContribution,
  type CredentialStorage,
} from "@frockbot/plugin-credentials/user";

interface ProbeEnv {
  CREDENTIAL_KEYRING: string;
}

const ACCOUNT_ID = "connector-probe-user";
const PACKAGE_ID = "telegram";
const CONNECTION_ID = "telegram-probe-connection";
const GENERATION = "probe-generation-1";

export class ChannelConnectorProbe extends DurableObject<ProbeEnv> {
  private readonly channels = new ChannelStore(this.ctx.storage);

  private readonly credentials = new CredentialUserBackendContribution({
    storage: this.ctx.storage as unknown as CredentialStorage,
    keyring: this.env.CREDENTIAL_KEYRING,
  });

  private service(): ChannelConnectorService {
    return new ChannelConnectorService({
      store: this.channels,
      connectors: new Map([
        [TELEGRAM_PLATFORM_V1, createTelegramConnectorV1()],
      ]),
      execute: (command, writer) => this.channels.execute(command, writer),
      // The whole point of the probe. The key is never a constructor argument
      // and never a field: it is sealed in storage, leased for one effect, and
      // opened here for exactly one outbound call.
      openConnectionKey: async (input) => {
        const lease = await this.credentials.lease({
          accountId: ACCOUNT_ID,
          connectionId: input.connectionId,
          packageId: PACKAGE_ID,
          effectId: input.effectId,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          expectedGeneration: GENERATION,
        });
        try {
          return await this.credentials.openLease({
            accountId: ACCOUNT_ID,
            packageId: PACKAGE_ID,
            lease,
          });
        } finally {
          await this.credentials
            .settle({
              accountId: ACCOUNT_ID,
              connectionId: input.connectionId,
              packageId: PACKAGE_ID,
              effectId: input.effectId,
            })
            .catch(() => undefined);
        }
      },
      resolvePlatform: () => Promise.resolve(TELEGRAM_PLATFORM_V1),
      tokenSecret: () => channelTokenSecretV1(this.env.CREDENTIAL_KEYRING),
    });
  }

  /** Seal one bot token, exactly as a `connection/create-api-key` would. */
  async sealBotToken(apiKey: string): Promise<void> {
    await this.credentials.stageApiKey({
      accountId: ACCOUNT_ID,
      connectionId: CONNECTION_ID,
      packageId: PACKAGE_ID,
      generation: GENERATION,
      apiKey,
    });
    await this.credentials.activate({
      accountId: ACCOUNT_ID,
      connectionId: CONNECTION_ID,
      packageId: PACKAGE_ID,
      generation: GENERATION,
    });
  }

  /** Named away from `connect` — `DurableObject` reserves that for sockets. */
  connectChannel(botId: string): Promise<{ webhookPath: string }> {
    return this.service().connect({
      userId: ACCOUNT_ID,
      botId,
      platform: TELEGRAM_PLATFORM_V1,
      connectionId: CONNECTION_ID,
      name: "Telegram probe",
      origin: "https://frockbot.test",
      commandId: "probe-connect",
    });
  }

  /**
   * One delivery, with a refusal answered rather than thrown.
   *
   * The production door turns the same refusal into a 404. Returning it here
   * keeps a refusal observable across the Durable Object RPC boundary, which an
   * exception is not.
   */
  async deliver(input: {
    token: string;
    presentedSecret: string | null;
    body: unknown;
  }): Promise<
    | { status: "accepted" | "ignored"; channelId: string; messageId?: string }
    | { status: "refused"; reason: string }
  > {
    try {
      return await this.service().deliver({
        platform: TELEGRAM_PLATFORM_V1,
        token: input.token,
        presentedSecret: input.presentedSecret,
        body: input.body,
      });
    } catch (error) {
      return {
        status: "refused",
        reason: error instanceof Error ? error.message : "refused",
      };
    }
  }

  reply(input: {
    channelId: string;
    botId: string;
    text: string;
    inReplyTo: string;
    ordinal: number;
    hop: number;
  }): Promise<ChannelOutboundReceiptV1> {
    return this.service().reply(input);
  }

  disconnect(input: { channelId: string; botId: string; commandId: string }) {
    return this.service().disconnect(input);
  }

  thread(channelId: string) {
    return this.channels.thread(channelId);
  }

  /**
   * Everything this object has written down, as one string.
   *
   * A test searches it for the plaintext bot token. It is the only honest way
   * to assert "the key is not stored in the clear": the assertion has to be able
   * to see every key, not the ones the implementation offers.
   */
  async durableDump(): Promise<string> {
    const stored = await this.ctx.storage.list<unknown>();
    return JSON.stringify([...stored.entries()]);
  }
}
