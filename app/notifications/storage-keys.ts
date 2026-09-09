// The Bot Durable Object storage keys the message-notification path owns.
//
// A leaf module so the writer and the drainer share one definition: the unread
// command writes the read intent, `messageRecords` writes the message intents,
// and the Durable Object drains both. A rename that reached only one of them
// would strand delivery, so none of them names these keys itself.

/** One undelivered `MessageNotice`, keyed by its message cursor. */
export const PUSH_OUTBOX_PREFIX = "shell:push:";
/** The one undelivered read cursor: what every other device should clear. */
export const PUSH_READ_KEY = "shell:push-read";
