package com.vanessa.mobile.voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OfflineTtsPlaybackGateTest {
    private fun fixture(): Pair<OfflineTtsPlaybackGate, MutableList<OfflineTtsPlaybackEvent>> {
        val events = mutableListOf<OfflineTtsPlaybackEvent>()
        return OfflineTtsPlaybackGate { event -> events.add(event) } to events
    }

    @Test
    fun acceptsStartAndCompletionForTheActiveUtterance() {
        val (gate, events) = fixture()

        assertTrue(gate.begin("utterance-a"))
        assertTrue(gate.isCurrent("utterance-a"))
        gate.started("utterance-a")
        gate.completed("utterance-a")

        assertEquals(
            listOf(
                OfflineTtsPlaybackStatus.STARTING,
                OfflineTtsPlaybackStatus.SPEAKING,
                OfflineTtsPlaybackStatus.COMPLETED,
            ),
            events.map { it.status },
        )
        assertFalse(gate.isCurrent("utterance-a"))
    }

    @Test
    fun callbacksFromReplacedUtteranceCannotChangeTheNewPlayback() {
        val (gate, events) = fixture()
        gate.begin("utterance-a")
        gate.started("utterance-a")
        gate.begin("utterance-b")
        val countAtReplacement = events.size

        gate.completed("utterance-a")
        gate.failed("utterance-a", "late failure")
        gate.stoppedByEngine("utterance-a")

        assertEquals(countAtReplacement, events.size)
        assertTrue(gate.isCurrent("utterance-b"))
        gate.started("utterance-b")
        gate.completed("utterance-b")
        assertEquals(OfflineTtsPlaybackStatus.COMPLETED, events.last().status)
        assertEquals("utterance-b", events.last().utteranceId)
    }

    @Test
    fun explicitStopInvalidatesTheEngineCallbackBeforeItArrives() {
        val (gate, events) = fixture()
        gate.begin("utterance-a")
        gate.started("utterance-a")

        assertTrue(gate.stop())
        val countAfterStop = events.size
        gate.completed("utterance-a")
        gate.failed("utterance-a", "late error")

        assertEquals(countAfterStop, events.size)
        assertEquals(OfflineTtsPlaybackStatus.STOPPED, events.last().status)
        assertFalse(gate.stop())
    }

    @Test
    fun errorTerminatesOnlyTheMatchingUtterance() {
        val (gate, events) = fixture()
        gate.begin("utterance-a")
        gate.failed("different-id", "not current")
        assertTrue(gate.isCurrent("utterance-a"))

        gate.failed("utterance-a", "voice service unavailable")

        assertEquals(OfflineTtsPlaybackStatus.ERROR, events.last().status)
        assertEquals("voice service unavailable", events.last().detail)
        assertFalse(gate.isCurrent("utterance-a"))
    }

    @Test
    fun closeStopsTheCurrentUtteranceAndIgnoresLateCallbacks() {
        val (gate, events) = fixture()
        gate.begin("utterance-a")
        gate.close()
        val countAfterClose = events.size
        gate.completed("utterance-a")

        assertEquals(OfflineTtsPlaybackStatus.STOPPED, events.last().status)
        assertEquals(countAfterClose, events.size)
    }

    @Test
    fun blankUtteranceIdsAreRejected() {
        val (gate, events) = fixture()
        assertFalse(gate.begin(" "))
        assertTrue(events.isEmpty())
    }
}
