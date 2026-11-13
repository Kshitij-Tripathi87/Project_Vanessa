package com.vanessa.mobile.pairing

import com.vanessa.mobile.di.StoredPairing
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingStateTest {

    private val now = 1_700_000_000_000L

    private fun stored(expiresAt: Long, code: String = "abc123") =
        StoredPairing(pcIp = "192.168.1.10", port = 8765, pairingCode = code, expiresAt = expiresAt)

    @Test
    fun `no stored pairing shows the idle screen`() {
        assertEquals(PairingStatus.Idle, PairingState.statusFor(null, now))
    }

    @Test
    fun `an unexpired code counts as captured`() {
        assertEquals(PairingStatus.CodeScanned, PairingState.statusFor(stored(now + 1), now))
    }

    @Test
    fun `a code expiring exactly now is not captured`() {
        assertEquals(PairingStatus.Idle, PairingState.statusFor(stored(now), now))
    }

    @Test
    fun `an expired code falls back to idle`() {
        assertEquals(PairingStatus.Idle, PairingState.statusFor(stored(now - 60_000), now))
    }

    @Test
    fun `a payload without a PC-set expiry still shows captured`() {
        assertEquals(
            PairingStatus.CodeScanned,
            PairingState.statusFor(stored(PairingPayloadParser.NO_EXPIRY), now),
        )
    }

    @Test
    fun `expiry checks ignore the no-expiry sentinel`() {
        assertFalse(PairingState.isExpired(stored(PairingPayloadParser.NO_EXPIRY), now))
        assertFalse(PairingState.isExpired(stored(now + 1), now))
        assertTrue(PairingState.isExpired(stored(now), now))
        assertTrue(PairingState.isExpired(stored(now - 1), now))
    }

    @Test
    fun `a pairing holding a device secret counts as paired`() {
        val paired = stored(PairingPayloadParser.NO_EXPIRY).copy(deviceId = "device_x", secret = "s3cret")
        assertEquals(PairingStatus.Paired, PairingState.statusFor(paired, now))
    }
}
