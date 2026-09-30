# Push relay

`push.frockbot.com` lets any FrockBot server, self-hosted included, notify the released FrockBot apps. It works the way Matrix's push gateway works for Element: servers anywhere send to this one Worker, and only it holds the Firebase service account that can reach the apps. It is free, needs no FrockBot account, and is deployed only by the hosted profile.

## Doors

| Route              | Body                                  | Answer                                                                                             |
| ------------------ | ------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `POST /register`   | `{ token, platform, server }`         | `{ handle }`: an opaque, unguessable handle for this token                                         |
| `POST /register`   | `{ token, platform, server, handle }` | `{ handle }`, the same one, now pointing at a rotated token; 404 when the handle is gone           |
| `POST /unregister` | `{ handle }`                          | 204, whether or not the handle existed                                                             |
| `POST /send`       | `{ handle, data, notify, collapse? }` | 200 sent · 410 handle gone · 429 or 503 not sent, retry later · 502 outcome unknown, do not repeat |

`server` is the origin of the FrockBot server the app registered the handle for. The app calls `/register` and `/unregister`; the server calls `/send`.

## What passes through

Nothing an alert says. `data` may hold only the fields the apps read (`userId`, `botId`, `groupId`, `cursor`, `kind`, `notify`, `sealed`), each checked; a `title` or `body` is refused. The words travel in `sealed`, encrypted by the server to a key only the app holds ([`core/push/seal.ts`](../../core/push/seal.ts), RFC 8291), and the app opens them before it draws the notification. An iPhone is sent a placeholder alert with `mutable-content` that the app's Notification Service Extension replaces.

The relay never hands back the FCM token, and the server never sees it.

## Limits

- 60 sends a minute per handle.
- 3,000 sends a minute per sending server, counted by the `server` origin its apps registered for, because servers on Workers share Cloudflare's egress addresses.
- 30 fresh registrations an hour per client address.
- A request of at most 4 KiB, and `sealed` of at most 3,072 characters.
- A handle unused for 90 days is forgotten.

## State

One Durable Object class, `RelayObject`, named either `handle:<handle>` (the token, platform and server origin, plus that handle's send window) or `limit:<key>` (one fixed window, which forgets itself when idle).

## Configuration

The Worker secret `FCM_SERVICE_ACCOUNT` is the Firebase service account for project `frock-bot`, the same one the hosted app Worker uses. `release.yml` deploys it with the hosted profile's `pushRelay` Worker; no other profile names it.
