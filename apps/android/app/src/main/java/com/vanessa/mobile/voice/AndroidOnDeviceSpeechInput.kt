package com.vanessa.mobile.voice

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.annotation.RequiresApi
import java.util.Locale

/**
 * Android on-device recognizer only. It never creates the network-capable default
 * recognizer; older devices or missing offline language packs stay on typed input.
 */
class AndroidOnDeviceSpeechInput(
    context: Context,
    private val onTranscript: (String) -> Unit,
    private val onState: (String) -> Unit,
) {
    private val appContext = context.applicationContext
    private var recognizer: SpeechRecognizer? = null

    fun isAvailable(): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
            SpeechRecognizer.isOnDeviceRecognitionAvailable(appContext)

    fun start(): Boolean {
        if (!isAvailable()) {
            onState("On-device speech recognition is unavailable on this device. Type your request instead.")
            return false
        }
        return try {
            stopAndDestroy()
            @Suppress("NewApi")
            createOnDeviceRecognizer()
            val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toLanguageTag())
                putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
                putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            }
            onState("Listening with the on-device recognizer…")
            recognizer?.startListening(intent) ?: return false
            true
        } catch (error: Exception) {
            onState("Could not start offline speech recognition: ${error.message ?: "unknown error"}")
            false
        }
    }

    @RequiresApi(Build.VERSION_CODES.S)
    private fun createOnDeviceRecognizer() {
        val instance = SpeechRecognizer.createOnDeviceSpeechRecognizer(appContext)
        recognizer = instance
        instance.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) = onState("Listening…")
            override fun onBeginningOfSpeech() = Unit
            override fun onRmsChanged(rmsdB: Float) = Unit
            override fun onBufferReceived(buffer: ByteArray?) = Unit
            override fun onEndOfSpeech() = onState("Processing speech locally…")
            override fun onError(error: Int) {
                onState("Offline speech recognition failed (code ${error}). You can type the request.")
                destroyRecognizer(cancel = false)
            }
            override fun onResults(results: Bundle?) {
                val transcript = results
                    ?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                    ?.firstOrNull()
                    ?.trim()
                    .orEmpty()
                destroyRecognizer(cancel = false)
                if (transcript.isBlank()) {
                    onState("No speech was recognized. Try again or type your request.")
                } else {
                    onState("Recognized locally.")
                    onTranscript(transcript)
                }
            }
            override fun onPartialResults(partialResults: Bundle?) = Unit
            override fun onEvent(eventType: Int, params: Bundle?) = Unit
        })
    }

    fun stop() {
        try { recognizer?.stopListening() } catch (_: Exception) { stopAndDestroy() }
    }

    fun close() {
        stopAndDestroy()
    }

    private fun stopAndDestroy() = destroyRecognizer(cancel = true)

    private fun destroyRecognizer(cancel: Boolean) {
        val active = recognizer
        recognizer = null
        if (active != null) {
            if (cancel) runCatching { active.cancel() }
            runCatching { active.destroy() }
        }
    }
}
