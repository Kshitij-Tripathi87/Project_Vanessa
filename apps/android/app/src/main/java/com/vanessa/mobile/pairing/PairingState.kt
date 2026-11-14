package com.vanessa.mobile.pairing

import com.vanessa.mobile.di.StoredPairing

enum class PairingStatus { Idle, CodeScanned, Paired, Error }

/** A pairing becomes active only after the PC locally approves the phone's key. */
object PairingState {
    fun statusFor(pairing: StoredPairing?, now: Long): PairingStatus = when {
        pairing == null -> PairingStatus.Idle
        pairing.deviceId != null -> PairingStatus.Paired
        pairing.expiresAt <= now -> PairingStatus.Idle
        else -> PairingStatus.CodeScanned
    }

    fun isExpired(pairing: StoredPairing, now: Long): Boolean = pairing.expiresAt <= now
}
