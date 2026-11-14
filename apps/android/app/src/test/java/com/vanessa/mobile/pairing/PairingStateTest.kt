package com.vanessa.mobile.pairing

import com.vanessa.mobile.di.StoredPairing
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingStateTest {
    private val now = 1_700_000_000_000L

    private fun stored(expiresAt: Long, deviceId: String? = null) = StoredPairing(
        pcIp = "winpc.tailnet.ts.net",
        port = 43443,
        pairingId = "pair_" + "a".repeat(24),
        pairingCode = "b".repeat(48),
        expiresAt = expiresAt,
        pcKeyId = "c".repeat(22),
        pcPublicKey = "A".repeat(87),
        deviceId = deviceId,
    )

    @Test fun noStoredPairingIsIdle() {
        assertEquals(PairingStatus.Idle, PairingState.statusFor(null, now))
    }

    @Test fun unexpiredV2PairingAwaitsPcApproval() {
        assertEquals(PairingStatus.CodeScanned, PairingState.statusFor(stored(now + 1), now))
    }

    @Test fun expiredClaimIsIdle() {
        assertEquals(PairingStatus.Idle, PairingState.statusFor(stored(now), now))
        assertEquals(PairingStatus.Idle, PairingState.statusFor(stored(now - 1), now))
    }

    @Test fun pcApprovedDeviceIsPaired() {
        assertEquals(PairingStatus.Paired, PairingState.statusFor(stored(now - 1, "device_12345678"), now))
    }

    @Test fun expiryIsCheckedExactlyAtExpiry() {
        assertFalse(PairingState.isExpired(stored(now + 1), now))
        assertTrue(PairingState.isExpired(stored(now), now))
    }
}
