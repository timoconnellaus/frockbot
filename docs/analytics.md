# Product analytics

FrockBot records what people do with it as product events in Cloudflare Analytics Engine, so that where new accounts stall in their first week can be read with SQL. The event names and the column layout are in `app/analytics/events.ts`. `scripts/analytics.ts` reads them.

Analytics Engine loses data by design. It samples under load and keeps about three months. So nothing reads these events to decide anything, and a write that fails is dropped. What a User must be able to see — the conversation, the audit and activity views — lives in the Bot's own durable records, never here. An event names who and what, never what was said: no message text, email address or tool arguments.

## Where events come from

| Event                  | Written by                                           | `kind`                              | `detail`                                                       |
| ---------------------- | ---------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------- |
| `account_created`      | User DO, the one-time General bootstrap              |                                     |                                                                |
| `app_opened`           | Gateway, each client's `/api/identity` read at start |                                     |                                                                |
| `message_sent`         | Gateway, an accepted `POST /api/bots/:bot/turns`     |                                     |                                                                |
| `push_registered`      | User DO, a new device or refreshed token only        |                                     |                                                                |
| `desktop_paired`       | User DO, machine enrollment                          |                                     |                                                                |
| `bot_created`          | User DO                                              | `general`, `user` or `bot`          |                                                                |
| `turn_settled`         | Bot DO, when a Turn settles                          | status                              | origin: `chat`, `routine`, `voice`, `email`, `group`, `bot`, … |
| `tool_used`            | Bot DO, once per tool per settled Turn (`count`)     | tool name                           | origin                                                         |
| `routine_created`      | Bot DO, a Routine made on the Routines page          | `user`                              |                                                                |
| `plugin_installed`     | User DO                                              | package id                          |                                                                |
| `plugin_enabled`       | Bot DO                                               | plugin id                           |                                                                |
| `voice_call_started`   | Voice DO, a new call (not a rejoin)                  |                                     |                                                                |
| `checkout_started`     | User DO                                              | `subscription` or `topup`           | plan                                                           |
| `trial_started`        | User DO, the ledger's `trialUsed` turning true       | plan                                |                                                                |
| `subscription_changed` | User DO                                              | status, or `cancelling`             | plan                                                           |
| `paid_period`          | User DO, a new paid month                            | plan                                |                                                                |
| `credit_exhausted`     | User DO, at most once a day                          | `credit` or `subscription-required` |                                                                |
| `account_suspended`    | User DO                                              |                                     |                                                                |

A Bot's own Routines, memories, Skills, Plugins and Computer use are its tools, so they are `tool_used` rows (`routine_manage`, `memory_write`, `skill_write`, `plugin_create`, `computer_*`, …) rather than events of their own. A new tool is counted without a change here.

The payment events are the difference in the account's payments state across one payments command. Checkout, webhooks and the provider's portal are all counted the same way.

The platform and app version come from the `platform` and `nativeVersion` fields of the client's `x-frockbot-client` hello. Only the gateway events carry them. `push_registered` and `desktop_paired` carry the platform their own registration names.

## Columns

| Column    | Field                                                                   |
| --------- | ----------------------------------------------------------------------- |
| `index1`  | userId (the sampling key: a User's events are kept or dropped together) |
| `blob1`   | event name                                                              |
| `blob2`   | userId                                                                  |
| `blob3`   | botId                                                                   |
| `blob4`   | `kind`                                                                  |
| `blob5`   | `detail`                                                                |
| `blob6`   | platform                                                                |
| `blob7`   | app version                                                             |
| `double1` | micro-dollars                                                           |
| `double2` | duration, ms                                                            |
| `double3` | count (1 unless stated)                                                 |

Columns are positional: add new fields at the end and never reorder. Count with `SUM(_sample_interval)`, not `COUNT()`, so sampled rows are weighted.

## Reading it

Put an API token with **Account Analytics Read** in `CLOUDFLARE_ANALYTICS_TOKEN`, either in the environment or in `.dev.vars`.

```sh
bun scripts/analytics.ts funnel          # of accounts created in the last 30 days, who reached each milestone in their first week
bun scripts/analytics.ts events --days 7 # every event and kind, with events and distinct users
bun scripts/analytics.ts sql "SELECT blob4 AS tool, SUM(_sample_interval) AS calls FROM {dataset} WHERE blob1 = 'tool_used' GROUP BY tool ORDER BY calls DESC"
```

`--profile staging` reads staging's dataset. Each deployment writes its own dataset, `<prefix>-events` unless its profile names `resources.analyticsDataset`. The local environments bind none and write nothing.
