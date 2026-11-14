package com.vanessa.mobile.pairing

import com.vanessa.mobile.di.StoredPairing

enum class PairingStatus { Idle, CodeScanned, AwaitingApproval, Paired, Error }

/** Derives persisted trust state without retaining a pairing code or shared secret. */
object PairingState {
    fun statusFor(pairing: StoredPairing?, now: Long): PairingStatus = when {
        pairing == null -> PairingStatus.Idle
        !pairing.deviceId.isNullOrBlank() -> PairingStatus.Paired
        pairing.expiresAt > now -> PairingStatus.CodeScanned
        else -> PairingStatus.Idle
    }

    fun isExpired(pairing: StoredPairing, now: Long): Boolean =
        pairing.expiresAt <= now
}
