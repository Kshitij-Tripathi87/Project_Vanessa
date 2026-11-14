package com.vanessa.mobile.voice

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import java.util.Locale

/**
 * Android 8+ speech input for remote commands.
 *
 * Android's on-device recognizer is preferred when available. On older versions
 * the installed system recognizer is used with EXTRA_PREFER_OFFLINE; the OS
 * speech service may still use network processing depending on the device.
 * The transcript is returned to the UI for review before it is sent to the PC.
 */
class RemoteSpeechInput(
    context: Context,
    private val onTranscript: (String) -> Unit,
    private val onState: (String) -> Unit,
) {
    private val appContext = context.applicationContext
    private var recognizer: SpeechRecognizer? = null

    fun start(): Boolean {
        if (!SpeechRecognizer.isRecognitionAvailable(appContext)) {
            onState("No compatible Android speech recognition service is installed.")
            return false
        }
        return try {
            closeRecognizer(cancel = true)
            recognizer = createRecognizer()
            val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toLanguageTag())
                putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
                putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            }
            onState("Listening… Speak your laptop command.")
            recognizer?.startListening(intent) ?: return false
            true
        } catch (error: Exception) {
            closeRecognizer(cancel = true)
            onState("Could not start speech recognition: ${error.message ?: "unknown error"}")
            false
        }
    }

    private fun createRecognizer(): SpeechRecognizer {
        val instance = if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
            SpeechRecognizer.isOnDeviceRecognitionAvailable(appContext)
        ) {
            @Suppress("NewApi")
            SpeechRecognizer.createOnDeviceSpeechRecognizer(appContext)
        } else {
            SpeechRecognizer.createSpeechRecognizer(appContext)
        }
        instance.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) = onState("Listening…")
            override fun onBeginningOfSpeech() = Unit
            override fun onRmsChanged(rmsdB: Float) = Unit
            override fun onBufferReceived(buffer: ByteArray?) = Unit
            override fun onEndOfSpeech() = onState("Processing transcript…")
            override fun onError(error: Int) {
                closeRecognizer(cancel = false)
                onState("Speech recognition failed (code $error). Type your command or try again.")
            }
            override fun onResults(results: Bundle?) {
                val transcript = results
                    ?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                    ?.firstOrNull()
                    ?.trim()
                    .orEmpty()
                closeRecognizer(cancel = false)
                if (transcript.isBlank()) {
                    onState("No speech was recognized. Try again or type your command.")
                } else {
                    onState("Transcript ready. Review it, then send it to the laptop.")
                    onTranscript(transcript)
                }
            }
            override fun onPartialResults(partialResults: Bundle?) = Unit
            override fun onEvent(eventType: Int, params: Bundle?) = Unit
        })
        return instance
    }

    fun stop() {
        try { recognizer?.stopListening() } catch (_: Exception) { closeRecognizer(cancel = true) }
    }

    fun close() = closeRecognizer(cancel = true)

    private fun closeRecognizer(cancel: Boolean) {
        val active = recognizer
        recognizer = null
        if (active != null) {
            if (cancel) runCatching { active.cancel() }
            runCatching { active.destroy() }
        }
    }
}
