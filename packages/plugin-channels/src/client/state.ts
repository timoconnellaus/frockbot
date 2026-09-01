import type { InjectionKey, Ref } from "vue";
import type { ChannelThreadPageViewV1, ChannelViewV1 } from "../shared.js";
import type { ChannelUnreadViewV1 } from "../unread.js";

/**
 * The Channels client state.
 *
 * Everything here is either backend state, decoded at the seam, or the
 * composer's own draft. Nothing derives unread, membership or `seq` — those
 * are the User Durable Object's, read through `/api/...` and rendered.
 */
export interface ChannelsWebData {
  /** The Bot whose rows these are: the shell's active Bot, and nothing else. */
  botId?: string;
  channels: ChannelViewV1[];
  /** Per-Channel unread, as the User Durable Object derives it. */
  unread: Record<string, ChannelUnreadViewV1>;
  /** The Channel the thread surface is showing. */
  activeChannelId?: string;
  thread?: ChannelThreadPageViewV1;
  loading: boolean;
  error?: string;
  /** Mirrors the composer store so a template can bind it. */
  draft: string;
  posting: boolean;
  postFailure?: string;
  /** The connect form: a Connection to speak through, and what came back. */
  connect: {
    connectionId: string;
    name: string;
    busy: boolean;
    error?: string;
    /** Returned once, to the User who asked. Held only while the form is open. */
    webhookPath?: string;
  };
  /** Re-read the list and the badges for one Bot. */
  load(botId: string): Promise<void>;
  /** Re-read the badges only. A poll refreshes them; it never clears one. */
  refreshUnread(): Promise<void>;
  /** Open one Channel's thread, and read it. */
  open(channelId: string): Promise<void>;
  close(): void;
  setDraft(draft: string): void;
  /** Post as the User: a peer in the room, never as one of its Bots. */
  post(): Promise<void>;
  /** The authenticated read receipt. Never fired from a poll. */
  markRead(channelId: string): Promise<void>;
  /** Connect the active Bot to a platform through one Connection. */
  connectChannel(platform: string): Promise<void>;
  /** Revoke the key and stop the deliveries. The history survives. */
  disconnect(channelId: string): Promise<void>;
}

export const channelsWebDataKey: InjectionKey<Ref<ChannelsWebData>> =
  Symbol("channels-web-data");

/** The surface id the sidebar opens a thread into. */
export const CHANNEL_THREAD_SURFACE_ID = "channels-thread";
