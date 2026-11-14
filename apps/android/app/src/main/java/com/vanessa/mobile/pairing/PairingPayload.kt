package com.vanessa.mobile.pairing

import com.vanessa.mobile.di.StoredPairing
import org.json.JSONObject

sealed interface PairingPayloadResult {
    data class Valid(val pairing: StoredPairing) : PairingPayloadResult
    data class Invalid(val reason: String) : PairingPayloadResult
}

/** Strict parser for the authenticated v2 QR payload shown by the Windows PC. */
object PairingPayloadParser {
    const val TYPE = "vanessa_remote_v2"
    const val VERSION = 2
    const val DEFAULT_PORT = 43443
    const val NO_EXPIRY = 0L

    fun parse(raw: String, now: Long = System.currentTimeMillis()): PairingPayloadResult {
        val parsed = runCatching { JSONObject(raw) }.getOrNull()
            ?: return PairingPayloadResult.Invalid("That QR code is not a Vanessa remote v2 pairing code.")

        val type = parsed.optString("type")
        val version = parsed.optInt("version", -1)
        if (type != TYPE || version != VERSION) {
            return PairingPayloadResult.Invalid("Unsupported pairing payload (type=$type version=$version).")
        }

        val host = parsed.optString("pcIp").trim().lowercase()
        val pairingId = parsed.optString("pairingId")
        val pairingCode = parsed.optString("pairingCode")
        val keyId = parsed.optString("pcKeyId")
        val publicKey = parsed.optString("pcPublicKey")
        val scheme = parsed.optString("scheme", "wss")
        val path = parsed.optString("path", "/remote-v2")
        if (host.isBlank() || pairingId.isBlank() || pairingCode.isBlank() ||
            keyId.isBlank() || publicKey.isBlank()) {
            return PairingPayloadResult.Invalid("The QR code is missing the host, pairing claim, or pinned PC identity.")
        }
        if (!host.matches(Regex("^[a-z0-9.-]{1,253}$")) ||
            host.startsWith(".") || host.endsWith(".") || host.contains("..")) {
            return PairingPayloadResult.Invalid("The QR code contains an invalid PC host.")
        }
        if (!pairingId.matches(Regex("^pair_[a-f0-9]{24}$")) ||
            !pairingCode.matches(Regex("^[a-fA-F0-9]{48}$"))) {
            return PairingPayloadResult.Invalid("The PC pairing claim is malformed.")
        }
        if (!keyId.matches(Regex("^[A-Za-z0-9_-]{16,128}$")) ||
            !publicKey.matches(Regex("^[A-Za-z0-9_-]{46,400}$"))) {
            return PairingPayloadResult.Invalid("The pinned PC identity is malformed.")
        }

        val port = parsed.optInt("port", DEFAULT_PORT)
        if (port !in 1..65535) return PairingPayloadResult.Invalid("The PC connection port is invalid.")
        if (scheme != "wss" && scheme != "ws") {
            return PairingPayloadResult.Invalid("Only WebSocket transport is supported.")
        }
        // Remote production pairing is only accepted over Tailscale's HTTPS
        // certificate. Cleartext WebSocket is permitted solely for loopback tests.
        if (scheme == "wss" && !host.endsWith(".ts.net")) {
            return PairingPayloadResult.Invalid("Remote connections must use the PC's Tailscale TLS hostname.")
        }
        if (scheme == "ws" && host != "127.0.0.1" && host != "localhost") {
            return PairingPayloadResult.Invalid("Cleartext WebSocket is restricted to loopback testing.")
        }
        if (path != "/remote-v2") return PairingPayloadResult.Invalid("Unsupported remote endpoint path.")

        val expiresAt = parsed.optLong("expiresAt", NO_EXPIRY)
        if (expiresAt <= now) return PairingPayloadResult.Invalid("That pairing code has expired. Show a fresh code on the PC.")

        return PairingPayloadResult.Valid(
            StoredPairing(
                pcIp = host,
                port = port,
                pairingId = pairingId,
                pairingCode = pairingCode,
                expiresAt = expiresAt,
                pcKeyId = keyId,
                pcPublicKey = publicKey,
                scheme = scheme,
                path = path,
            )
        )
    }
}
