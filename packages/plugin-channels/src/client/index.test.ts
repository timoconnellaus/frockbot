// The Channels Contribution, mounted into a shell fixture.
//
// The fixture is the `ClientPluginContext` the hosted application hands a
// Package: a transport, a slot registry, the surface registry the Shell
// provides, and the provider seam. Mounting against it is what proves the
// Package fills the slots it claims, registers the surface the sidebar opens,
// and — the part worth a test rather than a glance — that every write it makes
// is one versioned command and that nothing it renders carries a credential.
import { afterEach, describe, expect, test } from "bun:test";
import type {
  ClientPluginContext,
  ClientSlotRegistration,
  ClientSurfaceRegistration,
} from "@frockbot/client-core";
import { clientSurfaceRegistryKey } from "@frockbot/client-core";
import { createClientSurfaceRegistry } from "@frockbot/client-ui";
import { ref, type Ref } from "vue";
import { channelsClientPlugin } from "./index.js";
import {
  channelsWebDataKey,
  CHANNEL_THREAD_SURFACE_ID,
  type ChannelsWebData,
} from "./state.js";

const originalDocument = Object.getOwnPropertyDescriptor(
  globalThis,
  "document",
);

/**
 * "Read" means the person was looking. The Package asks the document whether
 * the page is visible before it sends a read receipt, so a fixture that wants
 * to observe one has to be a visible page.
 */
function installVisibleDocument(): void {
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { visibilityState: "visible" },
  });
}

afterEach(() => {
  if (originalDocument)
    Object.defineProperty(globalThis, "document", originalDocument);
  else Reflect.deleteProperty(globalThis, "document");
});

interface Call {
  path: string;
  method: string;
  body?: string;
}

interface Fixture {
  state: Ref<ChannelsWebData>;
  slots: ClientSlotRegistration[];
  surfaces: ClientSurfaceRegistration[];
  calls: Call[];
  dispose(): void;
}

function channelView(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    channelId: "room",
    kind: "group",
    name: "Standup",
    members: ["alpha", "beta"],
    revision: 1,
    active: true,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function messageView(seq: number, senderBotId: string) {
  return {
    schemaVersion: 1,
    messageId: `cm-${seq}`,
    channelId: "room",
    seq,
    senderBotId,
    text: `message ${seq}`,
    hop: 1,
    at: "2026-09-01T00:00:00.000Z",
    reactions: [],
  };
}

function mount(respond: (call: Call) => unknown = () => ({})): Fixture {
  const registry = createClientSurfaceRegistry();
  const slots: ClientSlotRegistration[] = [];
  const surfaces: ClientSurfaceRegistration[] = [];
  const calls: Call[] = [];
  let provided: Ref<ChannelsWebData> | undefined;
  const disposers: (() => void)[] = [];
  const context: ClientPluginContext = {
    transport: {
      turn: () => Promise.resolve({ runId: "run", text: "", events: [] }),
      hostedRequest: (path, method = "GET", body) => {
        const call = { path, method, ...(body === undefined ? {} : { body }) };
        calls.push(call);
        return Promise.resolve(respond(call));
      },
    },
    slot: (registration) => {
      slots.push(registration);
      return () => undefined;
    },
    provide: (key, value) => {
      if (key === channelsWebDataKey) provided = value as Ref<ChannelsWebData>;
      return () => undefined;
    },
    inject: <T>(key: unknown): T => {
      if (key === clientSurfaceRegistryKey) return registry as unknown as T;
      throw new Error("unexpected client provider injection");
    },
  };
  const result = channelsClientPlugin(context);
  if (Array.isArray(result)) disposers.push(...result);
  // The surface registry is the Shell's, so what the Package registered is read
  // back off it rather than off a stub that agreed with itself.
  for (const id of [CHANNEL_THREAD_SURFACE_ID]) {
    if (registry.has(id)) {
      registry.open(id);
      const active = registry.active.value;
      if (active) surfaces.push(active);
      registry.close();
    }
  }
  if (!provided) throw new Error("Channels state was not provided");
  return {
    state: provided,
    slots,
    surfaces,
    calls,
    dispose: () => {
      for (const dispose of disposers.toReversed()) dispose();
    },
  };
}

describe("Channels client surface", () => {
  test("fills the sidebar and info-pane slots the manifest claims", () => {
    const fixture = mount();

    expect(fixture.slots.map((slot) => slot.slot).toSorted()).toEqual([
      "frockbot.bot-info-channels",
      "frockbot.sidebar-bots",
    ]);
    fixture.dispose();
  });

  test("registers the thread surface the sidebar opens", () => {
    const fixture = mount();

    expect(fixture.surfaces).toHaveLength(1);
    expect(fixture.surfaces[0]!.id).toBe(CHANNEL_THREAD_SURFACE_ID);
    expect(fixture.surfaces[0]!.placement).toBe("panel");
    fixture.dispose();
  });

  test("loads one Bot's rooms and their badges in one pass", async () => {
    const fixture = mount((call) =>
      call.path === "/api/bots/alpha/channels"
        ? { schemaVersion: 1, botId: "alpha", channels: [channelView()] }
        : {
            schemaVersion: 1,
            botId: "alpha",
            unread: [
              {
                schemaVersion: 1,
                channelId: "room",
                count: 2,
                capped: false,
                pending: false,
                unread: true,
              },
            ],
          },
    );

    await fixture.state.value.load("alpha");

    expect(fixture.state.value.channels[0]!.name).toBe("Standup");
    expect(fixture.state.value.unread.room?.count).toBe(2);
    expect(fixture.calls.map((call) => call.path)).toEqual([
      "/api/bots/alpha/channels",
      "/api/bots/alpha/channels/unread",
    ]);
    fixture.dispose();
  });

  test("opening a Channel reads its thread and marks it read", async () => {
    const fixture = mount((call) => {
      if (call.path === "/api/channels/room") {
        return {
          schemaVersion: 1,
          channel: channelView(),
          messages: [messageView(0, "alpha"), messageView(1, "beta")],
          connectionLabel: "Standup bot",
        };
      }
      return {
        schemaVersion: 1,
        commandId: "one",
        status: "applied",
        unread: {
          schemaVersion: 1,
          channelId: "room",
          count: 0,
          capped: false,
          pending: false,
          unread: false,
          lastSeq: 1,
          lastReadSeq: 1,
        },
      };
    });
    fixture.state.value.botId = "alpha";
    installVisibleDocument();

    await fixture.state.value.open("room");

    expect(fixture.state.value.thread?.messages).toHaveLength(2);
    // The label, never the key: a connected Channel tells the WebUI what a
    // person called the Connection and nothing that could open it.
    expect(fixture.state.value.thread?.connectionLabel).toBe("Standup bot");
    const read = fixture.calls.find((call) => call.path.endsWith("/read"));
    expect(read?.method).toBe("POST");
    // The read position is the newest `seq` the thread carried, and the
    // command is versioned and carries its own idempotency key.
    const body = JSON.parse(read?.body ?? "{}") as Record<string, unknown>;
    expect(body.type).toBe("channel/mark-read");
    expect(body.upToSeq).toBe(1);
    expect(typeof body.commandId).toBe("string");
    expect(fixture.state.value.unread.room?.unread).toBe(false);
    fixture.dispose();
  });

  test("a refused post hands the text back with the reason", async () => {
    const fixture = mount((call) =>
      call.path.endsWith("/post")
        ? {
            schemaVersion: 1,
            commandId: "one",
            status: "refused",
            refusal: "quota",
            reason: "this room has used its messages for this minute",
          }
        : {},
    );
    fixture.state.value.botId = "alpha";
    fixture.state.value.activeChannelId = "room";
    fixture.state.value.setDraft("hello everyone");

    await fixture.state.value.post();

    expect(fixture.state.value.draft).toBe("hello everyone");
    expect(fixture.state.value.postFailure).toBe(
      "this room has used its messages for this minute",
    );
    // A person's words are the person's: the post names no Bot as the sender,
    // it names the member whose authority carries it.
    const post = fixture.calls.find((call) => call.path.endsWith("/post"));
    const body = JSON.parse(post?.body ?? "{}") as Record<string, unknown>;
    expect(body.botId).toBe("alpha");
    expect(body.text).toBe("hello everyone");
    expect(body.senderPeer).toBeUndefined();
    fixture.dispose();
  });

  test("disconnect names the member it acts as and re-reads the list", async () => {
    const fixture = mount((call) => {
      if (call.path.endsWith("/disconnect")) {
        return {
          schemaVersion: 1,
          commandId: "one",
          status: "applied",
          channel: channelView({ kind: "external", active: false }),
        };
      }
      if (call.path === "/api/bots/alpha/channels") {
        return { schemaVersion: 1, botId: "alpha", channels: [] };
      }
      return { schemaVersion: 1, botId: "alpha", unread: [] };
    });
    fixture.state.value.botId = "alpha";

    await fixture.state.value.disconnect("room");

    const disconnect = fixture.calls.find((call) =>
      call.path.endsWith("/disconnect"),
    );
    const body = JSON.parse(disconnect?.body ?? "{}") as Record<
      string,
      unknown
    >;
    expect(body.botId).toBe("alpha");
    expect(typeof body.commandId).toBe("string");
    expect(fixture.state.value.channels).toEqual([]);
    fixture.dispose();
  });
});
