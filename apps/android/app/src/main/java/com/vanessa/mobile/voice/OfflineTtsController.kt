package com.vanessa.mobile.voice

import android.content.Context
import android.speech.tts.TextToSpeech
import android.speech.tts.Voice
import java.util.Locale

/** Uses only an installed TTS voice that explicitly reports no network requirement. */
class OfflineTtsController(
    context: Context,
    private val onState: (ready: Boolean, message: String) -> Unit,
) : TextToSpeech.OnInitListener {
    private var engine: TextToSpeech? = TextToSpeech(context.applicationContext, this)
    @Volatile private var ready = false
    @Volatile private var closed = false

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
        onState(
            ready,
            if (ready) "Offline voice ready: ${voice.name}"
            else "Could not activate the selected offline voice.",
        )
    }

    fun speak(text: String): Boolean {
        val tts = engine ?: return false
        if (!ready || text.isBlank()) return false
        val bounded = text.take(4000)
        return tts.speak(
            bounded,
            TextToSpeech.QUEUE_FLUSH,
            null,
            "vanessa-${System.currentTimeMillis()}",
        ) == TextToSpeech.SUCCESS
    }

    fun stop() {
        engine?.stop()
    }

    fun close() {
        closed = true
        ready = false
        engine?.stop()
        engine?.shutdown()
        engine = null
    }
}
