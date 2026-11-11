package com.vanessa.mobile.pairing

import com.vanessa.mobile.di.StoredPairing
import org.json.JSONObject

/** Outcome of parsing the QR payload shown by the PC. */
sealed interface PairingPayloadResult {
    data class Valid(val pairing: StoredPairing) : PairingPayloadResult
    data class Invalid(val reason: String) : PairingPayloadResult
}

/**
 * Parses the `{type, version, pcIP, port, pairingCode, expiresAt}` payload the
 * PC encodes in its pairing QR code.
 *
 * The payload never carries the long-lived HMAC secret: the phone must redeem
 * the short-lived code with the PC, which then issues the per-device secret.
 * Parsing is pure so it can be unit-tested without an Android runtime.
 */
object PairingPayloadParser {

    const val TYPE = "vanessa_pairing"
    const val VERSION = 1
    const val DEFAULT_PORT = 8765
    private const val MIN_PORT = 1
    private const val MAX_PORT = 65535

    /** An absent `expiresAt` is treated as "the PC did not set an expiry". */
    const val NO_EXPIRY = 0L

    fun parse(raw: String, now: Long = System.currentTimeMillis()): PairingPayloadResult {
        val parsed = runCatching { JSONObject(raw) }.getOrNull()
            ?: return PairingPayloadResult.Invalid("That QR code is not a Vanessa pairing code.")

        val type = parsed.optString("type", TYPE)
        val version = parsed.optInt("version", VERSION)
        if (type != TYPE || version != VERSION) {
            return PairingPayloadResult.Invalid("Unsupported pairing payload (type=$type version=$version).")
        }

        // Older PC payloads used camelCase for the address field.
        val pcIp = parsed.optString("pcIP").ifBlank { parsed.optString("pcIp") }
        val pairingCode = parsed.optString("pairingCode")
        if (pcIp.isBlank() || pairingCode.isBlank()) {
            return PairingPayloadResult.Invalid("The pairing code is missing the PC address or code.")
        }

        val port = parsed.optInt("port", DEFAULT_PORT)
        if (port !in MIN_PORT..MAX_PORT) {
            return PairingPayloadResult.Invalid("The pairing code has an invalid port: $port.")
        }

        val expiresAt = parsed.optLong("expiresAt", NO_EXPIRY)
        if (expiresAt in 1..now) {
            return PairingPayloadResult.Invalid("That pairing code has expired. Show a fresh code on the PC.")
        }

        return PairingPayloadResult.Valid(
            StoredPairing(
                pcIp = pcIp,
                port = port,
                pairingCode = pairingCode,
                expiresAt = expiresAt,
            )
        )
    }
}
