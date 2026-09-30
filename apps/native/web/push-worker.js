// The web client's push service worker, served from the origin's root so a
// push reaches it while no tab is open. It draws notifications and opens the
// conversation a click names; it has no fetch handler, so it caches nothing
// and never stands between the page and the network.
//
// The cloud sends a browser only messages it is to be told about (`push.ts`),
// and every push must draw a notification: the subscription is
// `userVisibleOnly`. One notification per conversation, like Android's: a
// newer message replaces it and keeps the earlier lines beneath.

const MAX_LINES = 25;
const CURSOR = /^message-[0-9]{20}$/;
const BOT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const GROUP = /^g-[0-9a-f]{20}$/;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);

/** The notification's tag and the link a click opens, or null. */
function conversationOf(data) {
  const [parameter, id, key] =
    data.groupId !== undefined
      ? ["group", data.groupId, `group:${data.groupId}`]
      : ["bot", data.botId ?? "", data.botId];
  if (!(parameter === "group" ? GROUP : BOT).test(id)) return null;
  const url = new URL("/", self.location.origin);
  url.searchParams.set(parameter, id);
  return { key, link: url.href };
}

function newestCursor(messages) {
  return messages.length ? messages[messages.length - 1].cursor : "";
}

async function show(data) {
  const title = data.title || "New message";
  const body = data.body || "";
  const conversation = conversationOf(data);
  if (!conversation || !CURSOR.test(data.cursor ?? "")) {
    // Still drawn: a push that shows nothing is one the browser holds against
    // the site.
    await self.registration.showNotification(title, {
      body,
      icon: "/favicon.ico",
    });
    return;
  }
  const { key, link } = conversation;
  const existing = await self.registration.getNotifications({ tag: key });
  const previous = existing[0]?.data?.messages ?? [];
  const seen = previous.some((message) => message.cursor === data.cursor);
  const messages = seen
    ? previous
    : [...previous, { cursor: data.cursor, title, body }]
        .sort((a, b) => (a.cursor < b.cursor ? -1 : 1))
        .slice(-MAX_LINES);
  const latest = messages[messages.length - 1];
  const newest = newestCursor(previous);
  await self.registration.showNotification(latest.title, {
    body: messages
      .slice(-4)
      .map((message) => message.body)
      .join("\n"),
    tag: key,
    // Only a message newer than the one already shown alerts again; a
    // duplicate or an older, out-of-order one updates silently.
    renotify: !seen && data.cursor > newest,
    icon: "/favicon.ico",
    badge: "/favicon.ico",
    timestamp: Date.now(),
    data: { link, messages },
  });
}

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  event.waitUntil(show(data));
});

async function open(link) {
  const windows = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  const origin = self.location.origin;
  const tab = windows.find((client) => new URL(client.url).origin === origin);
  if (tab) {
    // The open app follows the link itself, so it keeps its state rather
    // than reloading.
    tab.postMessage({ type: "frockbot-open", link });
    await tab.focus();
    return;
  }
  await self.clients.openWindow(link);
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const link = event.notification.data?.link;
  if (typeof link === "string") event.waitUntil(open(link));
});

// The page asks for a conversation's notification to go once it has been
// read, here or on another device.
self.addEventListener("message", (event) => {
  const { type, key, cursor } = event.data ?? {};
  if (type !== "frockbot-read" || typeof key !== "string") return;
  event.waitUntil(
    self.registration.getNotifications({ tag: key }).then((shown) => {
      for (const notification of shown) {
        const newest = newestCursor(notification.data?.messages ?? []);
        if (typeof cursor === "string" && newest <= cursor)
          notification.close();
      }
    }),
  );
});
