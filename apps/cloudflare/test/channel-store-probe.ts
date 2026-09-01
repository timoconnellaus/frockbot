// The Channel authority against real workerd storage.
//
// `ChannelStore` is unit-tested over a Map, which proves its rules. This proves
// the property a Map cannot: that a message and the deliveries it owes are
// durable, so they are still there after the Durable Object holding them has
// been evicted and rebuilt from disk.
//
// It is a probe, not production: the production User Durable Object mounts the
// same class over the same `ctx.storage`, and this one exists so a test can
// drive the store directly without provisioning a whole User.
import { DurableObject } from "cloudflare:workers";
import { ChannelStore } from "@frockbot/plugin-channels/store";
import {
  decodeChannelCommandV1,
  type ChannelCommandReceiptV1,
} from "@frockbot/plugin-channels/shared";
import { decodeChannelWriterV1 } from "@frockbot/plugin-channels/records";

export class ChannelStoreProbe extends DurableObject {
  private readonly channels = new ChannelStore(this.ctx.storage);

  execute(input: {
    command: unknown;
    writer: unknown;
  }): Promise<ChannelCommandReceiptV1> {
    return this.channels.execute(
      decodeChannelCommandV1(input.command),
      decodeChannelWriterV1(input.writer),
    );
  }

  deliveries(messageId: string) {
    return this.channels.deliveries(messageId);
  }

  thread(channelId: string) {
    return this.channels.thread(channelId);
  }

  list(botId: string) {
    return this.channels.list(botId);
  }

  markAdmitted(messageId: string, botId: string, runId: string) {
    return this.channels.markAdmitted(messageId, botId, runId);
  }
}
