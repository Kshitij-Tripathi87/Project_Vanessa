package com.vanessa.mobile.pairing

import com.vanessa.protocol.v2.RemoteEnvelopeCrypto
import org.json.JSONObject
import java.net.URI
import java.util.Base64

data class RemoteV2PairingConfiguration(
    val wsUrl: String,
    val pcKeyId: String,
    val pcPublicKeySpki: String,
    val pcName: String,
    val pairingId: String,
    val code: String,
    val expiresAt: Long,
)

sealed interface RemoteV2PairingPayloadResult {
    data class Valid(val configuration: RemoteV2PairingConfiguration) : RemoteV2PairingPayloadResult
    data class Invalid(val reason: String) : RemoteV2PairingPayloadResult
}

/** Strict parser for the v2 QR payload emitted by the PC's authenticated gateway. */
object RemoteV2PairingPayloadParser {
    fun parse(raw: String, now: Long = System.currentTimeMillis()): RemoteV2PairingPayloadResult {
        val json = runCatching { JSONObject(raw) }.getOrNull()
            ?: return RemoteV2PairingPayloadResult.Invalid("This is not a valid Vanessa pairing QR payload.")
        if (json.optString("type") != "vanessa_remote_v2" ||
            json.optInt("version") != 2 || json.optInt("protocolVersion") != 2) {
            return RemoteV2PairingPayloadResult.Invalid("Unsupported remote pairing protocol.")
        }
        val wsUrl = json.optString("wsUrl")
        val keyId = json.optString("pcKeyId")
        val publicKey = json.optString("pcPublicKey")
        val pcName = json.optString("pcName")
        val pairingId = json.optString("pairingId")
        val code = json.optString("code")
        val expiresAt = json.optLong("expiresAt", 0L)
        val uri = runCatching { URI(wsUrl) }.getOrNull()
        if (uri == null || uri.scheme != "wss" || uri.host.isNullOrBlank() ||
            !uri.host.lowercase().endsWith(".ts.net") || uri.port != -1 ||
            uri.userInfo != null || uri.query != null || uri.fragment != null ||
            uri.path != "/remote-v2") {
            return RemoteV2PairingPayloadResult.Invalid("Pairing requires the PC's Tailscale WSS address.")
        }
        if (!keyId.matches(Regex("^[A-Za-z0-9_-]{16,128}$")) ||
            !publicKey.matches(Regex("^[A-Za-z0-9_-]{46,400}$"))) {
            return RemoteV2PairingPayloadResult.Invalid("The PC identity in this QR code is invalid.")
        }
        val derivedKeyId = runCatching {
            RemoteEnvelopeCrypto.keyId(Base64.getUrlDecoder().decode(publicKey))
        }.getOrNull()
        if (derivedKeyId != keyId) {
            return RemoteV2PairingPayloadResult.Invalid("The PC public key does not match its identity fingerprint.")
        }
        if (pcName.isBlank() || pcName.length > 80 ||
            !pairingId.matches(Regex("^pair_[a-f0-9]{24}$")) ||
            !code.matches(Regex("^[A-Za-z0-9-]{10,64}$"))) {
            return RemoteV2PairingPayloadResult.Invalid("The pairing QR is incomplete.")
        }
        if (expiresAt <= now) {
            return RemoteV2PairingPayloadResult.Invalid("This pairing code has expired. Generate a new code on the PC.")
        }
        return RemoteV2PairingPayloadResult.Valid(
            RemoteV2PairingConfiguration(
                wsUrl = uri.toString(),
                pcKeyId = keyId,
                pcPublicKeySpki = publicKey,
                pcName = pcName,
                pairingId = pairingId,
                code = code,
                expiresAt = expiresAt,
            )
        )
    }
}
