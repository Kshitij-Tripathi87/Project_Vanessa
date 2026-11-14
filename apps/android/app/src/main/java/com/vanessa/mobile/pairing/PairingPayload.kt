package com.vanessa.mobile.pairing

import com.vanessa.mobile.di.StoredPairing
import org.json.JSONObject
import java.net.URI

sealed interface PairingPayloadResult {
    data class Valid(val pairing: StoredPairing) : PairingPayloadResult
    data class Invalid(val reason: String) : PairingPayloadResult
}

/** Strict parser for the signed-protocol-v2 PC pairing QR payload. */
object PairingPayloadParser {
    const val VERSION = 2
    const val NO_EXPIRY = 0L

    fun parse(raw: String, now: Long = System.currentTimeMillis()): PairingPayloadResult {
        val parsed = runCatching { JSONObject(raw) }.getOrNull()
            ?: return PairingPayloadResult.Invalid("That QR code is not valid JSON.")

        if (parsed.optInt("version", -1) != VERSION) {
            return PairingPayloadResult.Invalid("This is not a Vanessa protocol-v2 pairing code.")
        }

        val endpointText = parsed.optString("endpoint")
        val pairingId = parsed.optString("pairingId")
        val code = parsed.optString("code")
        val pcKeyId = parsed.optString("pcKeyId")
        val pcPublicKey = parsed.optString("pcPublicKey")
        val expiresAt = parsed.optLong("expiresAt", NO_EXPIRY)

        if (endpointText.isBlank() || pairingId.isBlank() || code.isBlank() ||
            pcKeyId.isBlank() || pcPublicKey.isBlank()) {
            return PairingPayloadResult.Invalid("The pairing QR is missing its endpoint, one-time code, or PC identity.")
        }
        if (!pairingId.matches(Regex("^[A-Za-z0-9_-]{8,64}$")) ||
            !code.matches(Regex("^[A-Za-z0-9-]{10,64}$")) ||
            !pcKeyId.matches(Regex("^[A-Za-z0-9_-]{16,128}$")) ||
            !pcPublicKey.matches(Regex("^[A-Za-z0-9_-]{46,400}$"))) {
            return PairingPayloadResult.Invalid("The pairing QR contains malformed identity or pairing fields.")
        }

        val endpoint = runCatching { URI(endpointText) }.getOrNull()
            ?: return PairingPayloadResult.Invalid("The PC endpoint is invalid.")
        if (endpoint.scheme != "wss" || endpoint.host.isNullOrBlank() ||
            endpoint.path != "/remote/v2" || endpoint.userInfo != null ||
            endpoint.query != null || endpoint.fragment != null) {
            return PairingPayloadResult.Invalid("The PC must provide a secure WSS endpoint ending in /remote/v2.")
        }
        if (expiresAt <= now) {
            return PairingPayloadResult.Invalid("That pairing code has expired. Generate a fresh code on the PC.")
        }

        return PairingPayloadResult.Valid(
            StoredPairing(
                pcIp = endpoint.host,
                port = if (endpoint.port > 0) endpoint.port else 443,
                pairingCode = code,
                expiresAt = expiresAt,
                pairingId = pairingId,
                endpoint = endpointText,
                pcKeyId = pcKeyId,
                pcPublicKey = pcPublicKey,
            )
        )
    }
}
