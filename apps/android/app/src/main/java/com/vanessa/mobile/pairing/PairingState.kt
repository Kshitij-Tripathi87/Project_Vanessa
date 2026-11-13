package com.vanessa.mobile.pairing

import com.vanessa.mobile.di.StoredPairing

/** What the pairing screen should show for the persisted pairing state. */
enum class PairingStatus { Idle, CodeScanned, Paired, Error }

/**
 * Derives the screen state from persisted pairing data.
 *
 * A pairing that holds a device id and secret is fully paired and can sign
 * messages. Otherwise a stored code counts as captured while it has not
 * expired; `expiresAt` of [PairingPayloadParser.NO_EXPIRY] means the PC did not
 * set an expiry, so the code is still shown rather than silently treated as
 * absent.
 */
object PairingState {

    fun statusFor(pairing: StoredPairing?, now: Long): PairingStatus = when {
        pairing == null -> PairingStatus.Idle
        pairing.deviceId != null && pairing.secret != null -> PairingStatus.Paired
        pairing.expiresAt == PairingPayloadParser.NO_EXPIRY -> PairingStatus.CodeScanned
        pairing.expiresAt > now -> PairingStatus.CodeScanned
        else -> PairingStatus.Idle
    }

    fun isExpired(pairing: StoredPairing, now: Long): Boolean =
        pairing.expiresAt != PairingPayloadParser.NO_EXPIRY && pairing.expiresAt <= now
}
