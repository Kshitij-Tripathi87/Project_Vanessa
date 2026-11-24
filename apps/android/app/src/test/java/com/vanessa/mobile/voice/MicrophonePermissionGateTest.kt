package com.vanessa.mobile.voice

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MicrophonePermissionGateTest {
    @Test
    fun grantedResultIsAcceptedOnce() {
        val gate = MicrophonePermissionGate()
        assertTrue(gate.begin())
        assertTrue(gate.isPending)
        assertTrue(gate.resolve(true))
        assertFalse(gate.isPending)
        assertFalse(gate.resolve(true))
    }

    @Test
    fun cancelledRequestCannotStartAfterADelayedGrant() {
        val gate = MicrophonePermissionGate()
        assertTrue(gate.begin())
        gate.cancel()
        assertTrue(gate.isPending)
        assertFalse(gate.begin())
        assertFalse(gate.resolve(true))
        assertFalse(gate.isPending)
        assertTrue(gate.begin())
        assertTrue(gate.resolve(true))
    }

    @Test
    fun denialAndUnsolicitedResultsNeverAuthorizeCapture() {
        val gate = MicrophonePermissionGate()
        assertFalse(gate.resolve(true))
        assertTrue(gate.begin())
        assertFalse(gate.resolve(false))
        assertFalse(gate.resolve(true))
        assertTrue(gate.begin())
        assertFalse(gate.begin())
        assertTrue(gate.resolve(true))
    }
}
