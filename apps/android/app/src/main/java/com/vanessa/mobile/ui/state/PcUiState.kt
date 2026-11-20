package com.vanessa.mobile.ui.state

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * What the phone knows about the Windows PC, and nothing it does not.
 *
 * The dashboard used to say "Windows PC is not paired" whether or not one was,
 * and offered the same two task buttons regardless of what the PC could
 * actually do. Both were invention: the first contradicted the stored pairing,
 * the second offered capabilities the PC might not have.
 *
 * This model keeps the three facts separate, because they arrive at different
 * times and mean different things:
 *
 *  - [identity] is what is *stored* — it survives being offline.
 *  - [link] is what the *socket* is doing right now.
 *  - [capabilities] are what the PC *advertised for this session*. They are
 *    empty until a manifest arrives, and are dropped when the session ends,
 *    because a capability list is a property of a session, not a device.
 */
internal enum class PcLink { UNPAIRED, DISCONNECTED, CONNECTING, RECONNECTING, CONNECTED, ERROR }

/** The paired PC as stored on this phone. */
internal data class PcIdentity(
    val name: String,
    val endpoint: String,
    val fingerprint: String,
) {
    /** Fingerprints are long; the dashboard shows a prefix it can be matched against. */
    val shortFingerprint: String
        get() = if (fingerprint.length <= 16) fingerprint else fingerprint.take(16) + "…"
}

/** One thing the PC says it can do, from its manifest. */
internal data class PcCapability(
    val name: String,
    val description: String,
    val tier: String,
)

internal data class PcUiState(
    val link: PcLink = PcLink.UNPAIRED,
    val identity: PcIdentity? = null,
    val capabilities: List<PcCapability> = emptyList(),
    val manifestReceived: Boolean = false,
    /** The bridge's own line, shown verbatim. Never a paraphrase. */
    val detail: String = "Not connected",
) {
    val paired: Boolean get() = identity != null

    val canReconnect: Boolean
        get() = identity != null && link != PcLink.CONNECTING && link != PcLink.RECONNECTING

    fun capability(name: String): PcCapability? = capabilities.firstOrNull { it.name == name }

    companion object {
        /** "Connected securely to Desktop." → "Desktop". */
        fun nameFromConnected(detail: String): String? {
            val marker = "Connected securely to "
            if (!detail.startsWith(marker)) return null
            return detail.removePrefix(marker).removeSuffix(".").trim().ifBlank { null }
        }
    }
}

/**
 * Folds one bridge status line into the model.
 *
 * Only the bridge's own vocabulary is interpreted; anything unrecognised leaves
 * the link alone rather than being guessed at. Capabilities are cleared whenever
 * the session is not connected — a stale capability list attached to a dead
 * socket is exactly the kind of "look, it works" that this app must not show.
 */
internal fun reducePcConnection(state: PcUiState, detail: String): PcUiState {
    val link = when {
        detail.startsWith("Connected securely") -> PcLink.CONNECTED
        detail.startsWith("Reconnecting") -> PcLink.RECONNECTING
        detail.startsWith("Connecting") -> PcLink.CONNECTING
        detail.startsWith("Verifying PC identity") -> PcLink.CONNECTING
        detail.startsWith("Waiting for PC to verify") -> PcLink.CONNECTING
        detail.startsWith("Pairing proof accepted") -> PcLink.CONNECTING
        detail.startsWith("Phone paired") -> PcLink.CONNECTING
        detail.startsWith("Remote PC disconnected") -> PcLink.DISCONNECTED
        detail.startsWith("Invalid PC pairing QR") -> PcLink.ERROR
        detail.startsWith("Pairing did not complete") -> PcLink.ERROR
        detail.startsWith("Android Keystore identity is unavailable") -> PcLink.ERROR
        else -> state.link
    }

    val identity = if (link == PcLink.CONNECTED && state.identity == null) {
        PcIdentity(
            name = PcUiState.nameFromConnected(detail) ?: "Windows PC",
            endpoint = "",
            fingerprint = "",
        )
    } else {
        state.identity
    }

    val sessionAlive = link == PcLink.CONNECTED
    return state.copy(
        link = link,
        identity = identity,
        detail = detail,
        capabilities = if (sessionAlive) state.capabilities else emptyList(),
        manifestReceived = sessionAlive && state.manifestReceived,
    )
}

/**
 * Reads a `manifest.snapshot` payload.
 *
 * The manifest is the only source of capabilities. Malformed entries are
 * dropped rather than rendered as blank rows, and the list is capped at 50 so a
 * hostile or buggy PC cannot make the dashboard unbounded.
 */
internal fun applyManifest(state: PcUiState, payload: JsonObject): PcUiState {
    val capabilities = (payload["capabilities"] as? JsonArray)
        .orEmpty()
        .mapNotNull { element ->
            val json = element as? JsonObject ?: return@mapNotNull null
            fun text(key: String): String? =
                (json[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
            val name = text("name")?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
            PcCapability(
                name = name,
                description = text("description").orEmpty(),
                tier = text("tier").orEmpty(),
            )
        }
        .distinctBy { it.name }
        .sortedBy { it.name }
        .take(50)

    return state.copy(capabilities = capabilities, manifestReceived = true)
}
