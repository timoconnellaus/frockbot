package com.frockbot.mobile

import org.junit.Assert.assertEquals
import org.junit.Test

class BadgeReconcileTest {
    private fun reconcile(
        bots: Map<String, Int> = emptyMap(),
        silenced: List<String> = emptyList(),
        active: Set<String> = emptySet(),
        counts: Map<String, Int> = emptyMap(),
        messages: Set<String> = emptySet(),
    ) = badgeReconcileV1(
        bots,
        silenced,
        active,
        storedCount = { counts[it] },
        storedMessages = { it in messages },
    )

    @Test
    fun `a zero from the cloud drops the stored count and redraws the notification`() {
        val plan = reconcile(
            bots = mapOf("alpha" to 0),
            active = setOf("alpha"),
            counts = mapOf("alpha" to 5),
            messages = setOf("alpha"),
        )
        assertEquals(listOf("alpha"), plan.drop)
        assertEquals(listOf("alpha"), plan.refresh)
        assertEquals(emptyMap<String, Int>(), plan.store)
        assertEquals(emptyList<String>(), plan.cancel)
    }

    @Test
    fun `a zero for a Bot with no notification changes nothing to draw`() {
        val plan = reconcile(
            bots = mapOf("alpha" to 0),
            counts = mapOf("alpha" to 5),
        )
        assertEquals(listOf("alpha"), plan.drop)
        assertEquals(emptyList<String>(), plan.refresh)
    }

    @Test
    fun `a repeated zero redraws an active notification after count removal`() {
        val plan = reconcile(
            bots = mapOf("alpha" to 0),
            active = setOf("alpha"),
            messages = setOf("alpha"),
        )
        assertEquals(emptyList<String>(), plan.drop)
        assertEquals(listOf("alpha"), plan.refresh)
    }

    @Test
    fun `a repeated zero cancels an active notification after an interrupted read`() {
        val plan = reconcile(bots = mapOf("alpha" to 0), active = setOf("alpha"))
        assertEquals(emptyList<String>(), plan.drop)
        assertEquals(emptyList<String>(), plan.refresh)
        assertEquals(listOf("alpha"), plan.cancel)
    }

    @Test
    fun `a changed count is stored and only redrawn where a notification exists`() {
        val plan = reconcile(
            bots = mapOf("alpha" to 3, "beta" to 2, "gamma" to 4),
            active = setOf("alpha", "gamma"),
            counts = mapOf("alpha" to 2, "gamma" to 4),
        )
        assertEquals(mapOf("alpha" to 3, "beta" to 2), plan.store)
        assertEquals(listOf("alpha"), plan.refresh)
    }

    @Test
    fun `an unchanged count is neither stored nor redrawn`() {
        val plan = reconcile(
            bots = mapOf("alpha" to 3),
            active = setOf("alpha"),
            counts = mapOf("alpha" to 3),
        )
        assertEquals(emptyMap<String, Int>(), plan.store)
        assertEquals(emptyList<String>(), plan.refresh)
    }

    @Test
    fun `a silenced Bot loses its notification and everything held for it`() {
        val plan = reconcile(
            silenced = listOf("muted", "archived"),
            active = setOf("muted"),
            counts = mapOf("muted" to 2),
            messages = setOf("muted", "archived"),
        )
        assertEquals(listOf("muted"), plan.cancel)
        assertEquals(listOf("muted", "archived"), plan.forget)
    }

    @Test
    fun `a silenced Bot holding nothing costs no write and no cancel`() {
        val plan = reconcile(silenced = listOf("muted", "archived"))
        assertEquals(emptyList<String>(), plan.cancel)
        assertEquals(emptyList<String>(), plan.forget)
    }

    @Test
    fun `nothing is drawn for a Bot that has no notification up`() {
        val plan = reconcile(
            bots = mapOf("alpha" to 7),
            silenced = listOf("muted"),
            counts = mapOf("muted" to 1),
        )
        assertEquals(mapOf("alpha" to 7), plan.store)
        assertEquals(emptyList<String>(), plan.refresh)
        assertEquals(emptyList<String>(), plan.cancel)
    }
}
