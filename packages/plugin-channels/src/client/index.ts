/// <reference path="../env.d.ts" />

// The Channels hosted client Contribution.
//
// "The hosted client renders backend state and submits commands. It does not
// become an alternate authority." Every write here is one `POST` of one
// versioned command carrying its own idempotency key, and every read is
// decoded at the seam before a component sees it — the membership, the `seq`,
// the tapbacks and the badge all arrive already decided by the User Durable
// Object.
//
// Two things this module will not do. It never posts as a Bot: a message the
// person types is carried as a peer, so nothing here can put words in a Bot's
// mouth. And it never holds credential material: connect returns a webhook
// path once, to the User who asked, and what a connected Channel shows from
// then on is the Connection's label.
import type { ClientPlugin } from "@frockbot/client-core";
import { clientSurfaceRegistryKey } from "@frockbot/client-core";
import { ref } from "vue";
import {
  decodeChannelCommandReceiptV1,
  decodeChannelListViewV1,
  decodeChannelThreadPageViewV1,
} from "../shared.js";
import {
  decodeChannelReadReceiptV1,
  decodeChannelUnreadDirectoryViewV1,
} from "../unread.js";
import { ChannelComposerStore } from "./composer.js";
import ChannelsSidebar from "./ChannelsSidebar.vue";
import ChannelThreadSurface from "./ChannelThreadSurface.vue";
import ChannelConnectorsSection from "./ChannelConnectorsSection.vue";
import {
  channelsWebDataKey,
  CHANNEL_THREAD_SURFACE_ID,
  type ChannelsWebData,
} from "./state.js";
import "./styles.css";

/**
 * How often the Channels list re-reads its badges.
 *
 * The same cadence the Bot rows poll at, and for the same reason: a poll
 * refreshes a badge and never clears one. "Read" is an authenticated command
 * the User's own selection sends.
 */
const CHANNEL_POLL_INTERVAL_MS = 15_000;

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export const channelsClientPlugin: ClientPlugin = (ctx) => {
  if (!ctx.transport.hostedRequest) {
    throw new Error("Channels hosted transport is unavailable");
  }
  const request = ctx.transport.hostedRequest.bind(ctx.transport);
  const surfaces = ctx.inject(clientSurfaceRegistryKey);
  const composer = new ChannelComposerStore();
  const state = ref<ChannelsWebData>({
    channels: [],
    unread: {},
    loading: false,
    draft: "",
    posting: false,
    connect: { connectionId: "", name: "", busy: false },
    async load(botId) {
      state.value.botId = botId;
      state.value.loading = true;
      state.value.error = undefined;
      try {
        const list = decodeChannelListViewV1(
          await request(`/api/bots/${encodeURIComponent(botId)}/channels`),
        );
        state.value.channels = list.channels;
        await state.value.refreshUnread();
      } catch (error) {
        state.value.error = message(error, "Could not load Channels");
      } finally {
        state.value.loading = false;
      }
    },
    async refreshUnread() {
      const botId = state.value.botId;
      if (!botId) return;
      const directory = decodeChannelUnreadDirectoryViewV1(
        await request(`/api/bots/${encodeURIComponent(botId)}/channels/unread`),
      );
      state.value.unread = Object.fromEntries(
        directory.unread.map((view) => [view.channelId, view]),
      );
    },
    async open(channelId) {
      state.value.activeChannelId = channelId;
      state.value.draft = composer.draftFor(channelId);
      state.value.postFailure = composer.failureFor(channelId);
      state.value.error = undefined;
      if (!surfaces.has(CHANNEL_THREAD_SURFACE_ID)) return;
      surfaces.open(CHANNEL_THREAD_SURFACE_ID);
      try {
        state.value.thread = decodeChannelThreadPageViewV1(
          await request(`/api/channels/${encodeURIComponent(channelId)}`),
        );
      } catch (error) {
        state.value.error = message(error, "Could not open this Channel");
        return;
      }
      // Opening a thread while looking at it is what "read" means. A poll that
      // refreshed the same messages must never do this.
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "visible"
      ) {
        try {
          await state.value.markRead(channelId);
        } catch {
          // The badge stays until the next opening; nothing durable is lost.
        }
      }
    },
    close() {
      state.value.activeChannelId = undefined;
      state.value.thread = undefined;
      surfaces.close();
    },
    setDraft(draft) {
      const channelId = state.value.activeChannelId;
      if (!channelId) return;
      composer.setDraft(channelId, draft);
      state.value.draft = draft;
      state.value.postFailure = composer.failureFor(channelId);
    },
    async post() {
      const channelId = state.value.activeChannelId;
      const botId = state.value.botId;
      if (!channelId || !botId) return;
      const submission = composer.begin(channelId, state.value.draft);
      if (!submission) return;
      state.value.draft = composer.draftFor(channelId);
      state.value.posting = true;
      state.value.postFailure = undefined;
      try {
        const receipt = decodeChannelCommandReceiptV1(
          await request(
            `/api/channels/${encodeURIComponent(channelId)}/post`,
            "POST",
            JSON.stringify({
              commandId: submission.commandId,
              botId,
              text: submission.text,
            }),
          ),
        );
        // A refusal is a receipt, not an exception: hop, quota and membership
        // are answers, and the composer hands the text back with the reason.
        if (receipt.status === "refused") {
          state.value.draft =
            composer.reject(submission, receipt.reason) ?? state.value.draft;
          state.value.postFailure = composer.failureFor(channelId);
          return;
        }
        composer.settle(submission);
        state.value.thread = decodeChannelThreadPageViewV1(
          await request(`/api/channels/${encodeURIComponent(channelId)}`),
        );
        await state.value.markRead(channelId);
      } catch (error) {
        state.value.draft =
          composer.reject(submission, message(error, "Could not post")) ??
          state.value.draft;
        state.value.postFailure = composer.failureFor(channelId);
      } finally {
        state.value.posting = false;
      }
    },
    async markRead(channelId) {
      const upToSeq = state.value.thread?.messages.at(-1)?.seq;
      // Nothing has ever been said here: there is no position to read up to.
      if (upToSeq === undefined) return;
      const receipt = decodeChannelReadReceiptV1(
        await request(
          `/api/channels/${encodeURIComponent(channelId)}/read`,
          "POST",
          JSON.stringify({
            schemaVersion: 1,
            type: "channel/mark-read",
            commandId: crypto.randomUUID(),
            channelId,
            upToSeq,
          }),
        ),
      );
      state.value.unread[channelId] = receipt.unread;
    },
    async connectChannel(platform) {
      const botId = state.value.botId;
      const connectionId = state.value.connect.connectionId.trim();
      if (!botId || !connectionId) {
        state.value.connect.error = "Choose a Connection to connect through";
        return;
      }
      state.value.connect.busy = true;
      state.value.connect.error = undefined;
      try {
        const result = (await request(
          `/api/bots/${encodeURIComponent(botId)}/channels/${encodeURIComponent(platform)}`,
          "POST",
          JSON.stringify({
            commandId: crypto.randomUUID(),
            connectionId,
            ...(state.value.connect.name.trim().length > 0
              ? { name: state.value.connect.name.trim() }
              : {}),
          }),
        )) as { webhookPath?: unknown };
        // Held only while the form is open, and never stored: the path carries
        // the Channel's key, and no later read returns it.
        state.value.connect.webhookPath =
          typeof result.webhookPath === "string"
            ? result.webhookPath
            : undefined;
        await state.value.load(botId);
      } catch (error) {
        state.value.connect.error = message(error, "Could not connect");
      } finally {
        state.value.connect.busy = false;
      }
    },
    async disconnect(channelId) {
      const botId = state.value.botId;
      if (!botId) return;
      state.value.connect.busy = true;
      state.value.connect.error = undefined;
      try {
        const receipt = decodeChannelCommandReceiptV1(
          await request(
            `/api/channels/${encodeURIComponent(channelId)}/disconnect`,
            "POST",
            JSON.stringify({ commandId: crypto.randomUUID(), botId }),
          ),
        );
        if (receipt.status === "refused") {
          state.value.connect.error = receipt.reason;
          return;
        }
        state.value.connect.webhookPath = undefined;
        await state.value.load(botId);
      } catch (error) {
        state.value.connect.error = message(error, "Could not disconnect");
      } finally {
        state.value.connect.busy = false;
      }
    },
  });

  const poll = setInterval(() => {
    if (!state.value.botId) return;
    void state.value.refreshUnread().catch(() => {
      // A poll is a refresh, not authority: the next tick tries again and
      // nothing the User did is lost by a failed one.
    });
  }, CHANNEL_POLL_INTERVAL_MS);

  return [
    () => clearInterval(poll),
    ctx.provide(channelsWebDataKey, state),
    ctx.slot({
      slot: "frockbot.sidebar-bots",
      order: 20,
      component: ChannelsSidebar,
    }),
    ctx.slot({
      slot: "frockbot.bot-info-channels",
      order: 20,
      component: ChannelConnectorsSection,
    }),
    surfaces.register({
      id: CHANNEL_THREAD_SURFACE_ID,
      title: "Channel",
      placement: "panel",
      component: ChannelThreadSurface,
    }),
  ];
};

export default channelsClientPlugin;
