package com.vanessa.mobile.voice

/** Playback lifecycle reported by the installed, offline-only Android TTS engine. */
enum class OfflineTtsPlaybackStatus {
    IDLE,
    STARTING,
    SPEAKING,
    COMPLETED,
    STOPPED,
    ERROR,
}

data class OfflineTtsPlaybackEvent(
    val status: OfflineTtsPlaybackStatus,
    val utteranceId: String?,
    val detail: String? = null,
)

/**
 * Pure generation gate for asynchronous TTS callbacks.
 *
 * A callback is accepted only while its utterance ID is still active. Calling
 * stop(), starting a replacement utterance or closing the controller makes all
 * callbacks from the previous utterance stale.
 */
internal class OfflineTtsPlaybackGate(
    private val onEvent: (OfflineTtsPlaybackEvent) -> Unit,
) {
    private var activeUtteranceId: String? = null

    @Synchronized
    fun begin(utteranceId: String): Boolean {
        if (utteranceId.isBlank()) return false
        activeUtteranceId = utteranceId
        emit(OfflineTtsPlaybackStatus.STARTING, utteranceId)
        return true
    }

    @Synchronized
    fun started(utteranceId: String) {
        if (activeUtteranceId == utteranceId) {
            emit(OfflineTtsPlaybackStatus.SPEAKING, utteranceId)
        }
    }

    @Synchronized
    fun completed(utteranceId: String) {
        finish(utteranceId, OfflineTtsPlaybackStatus.COMPLETED, null)
    }

    @Synchronized
    fun failed(utteranceId: String, detail: String) {
        finish(
            utteranceId,
            OfflineTtsPlaybackStatus.ERROR,
            detail.trim().ifBlank { "Offline speech playback failed." }.take(240),
        )
    }

    @Synchronized
    fun stoppedByEngine(utteranceId: String) {
        finish(utteranceId, OfflineTtsPlaybackStatus.STOPPED, "Speech playback stopped.")
    }

    @Synchronized
    fun stop(): Boolean {
        val active = activeUtteranceId ?: return false
        activeUtteranceId = null
        emit(OfflineTtsPlaybackStatus.STOPPED, active, "Speech playback stopped.")
        return true
    }

    @Synchronized
    fun close() {
        stop()
    }

    @Synchronized
    fun isCurrent(utteranceId: String): Boolean = activeUtteranceId == utteranceId

    private fun finish(
        utteranceId: String,
        status: OfflineTtsPlaybackStatus,
        detail: String?,
    ) {
        if (activeUtteranceId != utteranceId) return
        activeUtteranceId = null
        emit(status, utteranceId, detail)
    }

    private fun emit(
        status: OfflineTtsPlaybackStatus,
        utteranceId: String?,
        detail: String? = null,
    ) {
        runCatching { onEvent(OfflineTtsPlaybackEvent(status, utteranceId, detail)) }
    }
}
