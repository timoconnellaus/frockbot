package com.frockbot.mobile

/**
 * What a badge reconcile does to stored state and to the notifications that
 * exist. Held apart from the effects so the rule can be read, and run, without
 * a device: [PushNotifications.badge] keeps every Android call.
 */
data class BadgeReconcile(
    /** Bots whose retained messages and stored count are both dropped. */
    val forget: List<String>,
    /** Bots whose stored count is dropped because the cloud says zero. */
    val drop: List<String>,
    /** Bots whose stored count is replaced by the cloud's. */
    val store: Map<String, Int>,
    /** Bots whose existing notification is taken away. */
    val cancel: List<String>,
    /** Bots whose existing notification is redrawn with the new count. */
    val refresh: List<String>,
)

/**
 * Reconciles the cloud's answer with what this device holds. [active] is the
 * set of Bots that still have a notification up; [storedCount] is null for a
 * Bot with no count held, and [storedMessages] is whether any message text is
 * retained. Nothing here invents a notification: a Bot is only refreshed or
 * cancelled when it already has one.
 */
fun badgeReconcileV1(
    bots: Map<String, Int>,
    silenced: List<String>,
    active: Set<String>,
    storedCount: (String) -> Int?,
    storedMessages: (String) -> Boolean,
): BadgeReconcile {
    val forget = mutableListOf<String>()
    val cancel = mutableListOf<String>()
    for (botId in silenced) {
        if (botId in active) cancel.add(botId)
        else if (storedCount(botId) == null && !storedMessages(botId)) continue
        forget.add(botId)
    }
    val drop = mutableListOf<String>()
    val store = LinkedHashMap<String, Int>()
    val refresh = mutableListOf<String>()
    for ((botId, count) in bots) {
        if (count <= 0) {
            if (storedCount(botId) == null) continue
            drop.add(botId)
        } else {
            if (storedCount(botId) == count) continue
            store[botId] = count
        }
        if (botId in active) refresh.add(botId)
    }
    return BadgeReconcile(forget, drop, store, cancel, refresh)
}
