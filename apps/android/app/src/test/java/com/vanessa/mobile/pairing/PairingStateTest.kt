package com.vanessa.mobile.pairing

import com.vanessa.mobile.di.StoredPairing
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingStateTest {
    private val now = 1_700_000_000_000L

    private fun stored(expiresAt: Long, deviceId: String? = null) = StoredPairing(
        pcIp = "vanessa-pc.tailnet.ts.net",
        port = 443,
        pairingCode = "",
        expiresAt = expiresAt,
        deviceId = deviceId,
        pairingId = "",
        endpoint = "wss://vanessa-pc.tailnet.ts.net/remote/v2",
        pcKeyId = "ABCDEFGHIJKLMNOPQRSTUV",
        pcPublicKey = "A".repeat(120),
    )

    @Test
    fun noStoredPairingShowsIdle() {
        assertEquals(PairingStatus.Idle, PairingState.statusFor(null, now))
    }

    @Test
    fun trustedDeviceIsPaired() {
        assertEquals(PairingStatus.Paired, PairingState.statusFor(stored(now + 1, "device-123456"), now))
    }

    @Test
    fun untrustedPairingIsCodeScannedWhileValid() {
        assertEquals(PairingStatus.CodeScanned, PairingState.statusFor(stored(now + 1), now))
    }

    @Test
    fun expiredPairingIsIdle() {
        assertEquals(PairingStatus.Idle, PairingState.statusFor(stored(now), now))
    }

    @Test
    fun expiryBoundaryTreatsExpiryInstantAsExpired() {
        assertFalse(PairingState.isExpired(stored(now + 1), now))
        assertTrue(PairingState.isExpired(stored(now), now))
        assertTrue(PairingState.isExpired(stored(now - 1), now))
    }
}
