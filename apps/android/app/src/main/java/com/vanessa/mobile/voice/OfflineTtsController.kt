package com.vanessa.mobile.voice

import android.content.Context
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import java.util.Locale
import java.util.UUID

/** Uses only an installed TTS voice that explicitly reports no network requirement. */
class OfflineTtsController(
    context: Context,
    private val onState: (ready: Boolean, message: String) -> Unit,
    onPlaybackEvent: (OfflineTtsPlaybackEvent) -> Unit = {},
) : TextToSpeech.OnInitListener {
    @Volatile private var closed = false
    @Volatile private var ready = false
    private val playbackGate = OfflineTtsPlaybackGate { event ->
        if (!closed) onPlaybackEvent(event)
    }
    private var engine: TextToSpeech? = TextToSpeech(context.applicationContext, this)

    override fun onInit(status: Int) {
        if (closed) return
        val tts = engine
        if (status != TextToSpeech.SUCCESS || tts == null) {
            ready = false
            onState(false, "Text-to-speech engine initialization failed.")
            return
        }
        val locale = Locale.getDefault()
        val voice: Voice? = tts.voices
            ?.filter {
                !it.isNetworkConnectionRequired &&
                    !it.features.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED) &&
                    it.locale.language == locale.language
            }
            ?.maxByOrNull { it.quality }
        if (voice == null) {
            ready = false
            onState(false, "No offline ${locale.displayLanguage} voice is installed. Text responses remain available.")
            return
        }

        val result = tts.setVoice(voice)
        ready = result == TextToSpeech.SUCCESS
        if (ready) installPlaybackListener(tts)
        onState(
            ready,
            if (ready) "Offline voice ready: ${voice.name}"
            else "Could not activate the selected offline voice.",
        )
    }

    private fun installPlaybackListener(tts: TextToSpeech) {
        tts.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String) {
                playbackGate.started(utteranceId)
            }

            override fun onDone(utteranceId: String) {
                playbackGate.completed(utteranceId)
            }

            override fun onError(utteranceId: String) {
                playbackGate.failed(utteranceId, "Android reported an offline speech playback error.")
            }

            override fun onError(utteranceId: String, errorCode: Int) {
                playbackGate.failed(
                    utteranceId,
                    "Android offline speech playback failed (error $errorCode).",
                )
            }

            override fun onStop(utteranceId: String, interrupted: Boolean) {
                playbackGate.stoppedByEngine(utteranceId)
            }
        })
    }

    /**
     * Starts one complete, bounded response. QUEUE_FLUSH replaces any previous
     * utterance; its late callbacks are ignored by the playback gate.
     */
    fun speak(text: String): Boolean {
        val tts = engine ?: return false
        val bounded = text.trim()
        if (closed || !ready || bounded.isEmpty() || bounded.length > MAX_UTTERANCE_LENGTH) {
            return false
        }

        val utteranceId = UUID.randomUUID().toString()
        if (!playbackGate.begin(utteranceId)) return false
        val result = tts.speak(
            bounded,
            TextToSpeech.QUEUE_FLUSH,
            null,
            utteranceId,
        )
        if (result != TextToSpeech.SUCCESS) {
            playbackGate.failed(utteranceId, "Android could not start the offline speech utterance.")
            return false
        }
        return true
    }

    /** Stops audio playback only. It never cancels a conversation turn or task. */
    fun stop(): Boolean {
        val hadActivePlayback = playbackGate.stop()
        if (hadActivePlayback) engine?.stop()
        return hadActivePlayback
    }

    fun close() {
        if (closed) return
        closed = true
        ready = false
        playbackGate.close()
        engine?.stop()
        engine?.shutdown()
        engine = null
    }

    private companion object {
        const val MAX_UTTERANCE_LENGTH = 4000
    }
}
