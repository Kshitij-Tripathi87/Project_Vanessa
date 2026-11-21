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
    /**
     * Draft of the sentence being spoken, updated as the recognizer revises it.
     *
     * The recognizer was already asked for partial results and then threw them
     * away, so the surface showed "Listening…" for the whole utterance and then
     * jumped straight to the final transcript. Showing the draft is what makes
     * the state legible while the user is still speaking.
     */
    private val onPartial: (String) -> Unit = {},
) {
    private val appContext = context.applicationContext
    private var recognizer: SpeechRecognizer? = null
    /** Fences delayed callbacks from a recognizer that has been stopped or replaced. */
    private var generation: Long = 0L

    fun isAvailable(): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
            SpeechRecognizer.isOnDeviceRecognitionAvailable(appContext)

    fun start(): Boolean {
        if (!isAvailable()) {
            onState("On-device speech recognition is unavailable on this device. Type your request instead.")
            return false
        }

        // Advance before destroying the prior recognizer. Its listener may still
        // deliver a queued callback after destroy(); that callback is now stale.
        generation += 1L
        val captureGeneration = generation
        return try {
            destroyRecognizer(cancel = true, invalidateGeneration = false)
            @Suppress("NewApi")
            createOnDeviceRecognizer(captureGeneration)
            val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toLanguageTag())
                putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
                putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            }
            onState("Listening with the on-device recognizer…")
            recognizer?.startListening(intent) ?: run {
                finishGeneration(captureGeneration)
                return false
            }
            true
        } catch (error: Exception) {
            if (generation == captureGeneration) finishGeneration(captureGeneration)
            onState("Could not start offline speech recognition: ${error.message ?: "unknown error"}")
            false
        }
    }

    @RequiresApi(Build.VERSION_CODES.S)
    private fun createOnDeviceRecognizer(captureGeneration: Long) {
        val instance = SpeechRecognizer.createOnDeviceSpeechRecognizer(appContext)
        recognizer = instance
        instance.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) {
                if (isCurrent(captureGeneration)) onState("Listening…")
            }
            override fun onBeginningOfSpeech() = Unit
            override fun onRmsChanged(rmsdB: Float) = Unit
            override fun onBufferReceived(buffer: ByteArray?) = Unit
            override fun onEndOfSpeech() {
                if (isCurrent(captureGeneration)) onState("Processing speech locally…")
            }
            override fun onError(error: Int) {
                if (!finishGeneration(captureGeneration)) return
                onState("Offline speech recognition failed (code ${error}). You can type the request.")
            }
            override fun onResults(results: Bundle?) {
                if (!isCurrent(captureGeneration)) return
                val transcript = results
                    ?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                    ?.firstOrNull()
                    ?.trim()
                    .orEmpty()
                if (!finishGeneration(captureGeneration)) return
                if (transcript.isBlank()) {
                    onState("No speech was recognized. Try again or type your request.")
                } else {
                    onState("Recognized locally.")
                    onTranscript(transcript)
                }
            }
            override fun onPartialResults(partialResults: Bundle?) {
                if (!isCurrent(captureGeneration)) return
                val draft = partialResults
                    ?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                    ?.firstOrNull()
                    ?.trim()
                    .orEmpty()
                // The recognizer also reports blank drafts between phrases; those
                // do not clear what is on screen.
                if (draft.isNotEmpty()) onPartial(draft)
            }
            override fun onEvent(eventType: Int, params: Bundle?) = Unit
        })
    }

    fun stop() {
        try { recognizer?.stopListening() } catch (_: Exception) { stopAndDestroy() }
    }

    fun close() {
        stopAndDestroy()
    }

    private fun isCurrent(captureGeneration: Long): Boolean = generation == captureGeneration

    /** Invalidate the generation before platform teardown can emit late callbacks. */
    private fun finishGeneration(captureGeneration: Long): Boolean {
        if (!isCurrent(captureGeneration)) return false
        generation += 1L
        destroyRecognizer(cancel = false, invalidateGeneration = false)
        return true
    }

    private fun stopAndDestroy() = destroyRecognizer(cancel = true)

    private fun destroyRecognizer(cancel: Boolean, invalidateGeneration: Boolean = true) {
        if (invalidateGeneration) generation += 1L
        val active = recognizer
        recognizer = null
        if (active != null) {
            if (cancel) runCatching { active.cancel() }
            runCatching { active.destroy() }
        }
    }
}
