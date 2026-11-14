package com.vanessa.mobile.ui

import ai.vanessa.agent.LocalPlanCoordinator
import ai.vanessa.agent.LocalPlanError
import ai.vanessa.agent.LocalPlanOutcome
import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.vanessa.mobile.agent.AndroidLocalToolExecutor
import com.vanessa.mobile.inference.LlamaCppInference
import com.vanessa.mobile.model.InstalledModel
import com.vanessa.mobile.model.ModelManager
import com.vanessa.mobile.profile.AndroidDeviceProfiler
import com.vanessa.mobile.profile.DeviceProfile
import com.vanessa.mobile.tools.CalendarSearchTool
import com.vanessa.mobile.voice.AndroidOnDeviceSpeechInput
import com.vanessa.mobile.voice.OfflineTtsController
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.util.Locale

private enum class VanessaDestination { HOME, VOICE, PAIRING, PC, SETTINGS }

class MainActivity : ComponentActivity() {
    private var destination by mutableStateOf(VanessaDestination.HOME)
    private var startupReady by mutableStateOf(false)
    private var startupMessage by mutableStateOf("Initializing Vanessa…")
    private var profile by mutableStateOf<DeviceProfile?>(null)
    private var installedModel by mutableStateOf<InstalledModel?>(null)
    private var modelStatus by mutableStateOf("Checking local model storage…")
    private var inferenceAvailable by mutableStateOf(false)
    private var modelLoaded by mutableStateOf(false)
    private var modelBusy by mutableStateOf(false)
    private var prompt by mutableStateOf("")
    private var assistantResponse by mutableStateOf("")
    private var assistantMetrics by mutableStateOf("")
    private var assistantBusy by mutableStateOf(false)
    private var speechStatus by mutableStateOf("Checking offline speech output…")
    private var speechReady by mutableStateOf(false)
    private var speechInputStatus by mutableStateOf("Checking on-device speech support…")
    private var onDeviceSpeechAvailable by mutableStateOf(false)
    private var voiceListening by mutableStateOf(false)
    private var microphonePermissionGranted by mutableStateOf(false)
    private var pairingNotice by mutableStateOf<String?>(null)

    private val profiler by lazy { AndroidDeviceProfiler(applicationContext) }
    private val calendarTool by lazy { CalendarSearchTool(applicationContext) }
    private val modelManager by lazy { ModelManager(applicationContext) }
    private var offlineTts: OfflineTtsController? = null
    private var onDeviceSpeechInput: AndroidOnDeviceSpeechInput? = null
    private var pendingAgentPrompt: String? = null
    private var inference: LlamaCppInference? = null

    private val requestCalendar =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            refreshProfile()
            val retry = pendingAgentPrompt
            pendingAgentPrompt = null
            if (retry != null) {
                assistantBusy = false
                if (granted) runAssistant(retry)
                else assistantResponse =
                    "Calendar permission was denied. Vanessa did not read any calendar events."
            }
        }

    private val requestMicrophone =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            microphonePermissionGranted = granted
            if (granted) startSpeechInput()
            else {
                voiceListening = false
                speechInputStatus = "Microphone permission denied. You can type your request instead."
            }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        destination = savedInstanceState?.getString("vanessa_destination")
            ?.let { runCatching { VanessaDestination.valueOf(it) }.getOrNull() }
            ?: VanessaDestination.HOME
        prompt = savedInstanceState?.getString("vanessa_prompt").orEmpty()
        window.statusBarColor = android.graphics.Color.rgb(10, 11, 15)
        window.navigationBarColor = android.graphics.Color.rgb(10, 11, 15)
        microphonePermissionGranted = hasMicrophonePermission()

        setContent {
            VanessaTheme {
                BackHandler(enabled = startupReady && destination != VanessaDestination.HOME) {
                    destination = when (destination) {
                        VanessaDestination.VOICE -> VanessaDestination.HOME
                        VanessaDestination.PAIRING -> VanessaDestination.PC
                        VanessaDestination.PC, VanessaDestination.SETTINGS -> VanessaDestination.HOME
                        VanessaDestination.HOME -> VanessaDestination.HOME
                    }
                }

                VanessaApp(
                    startupReady = startupReady,
                    startupMessage = startupMessage,
                    destination = destination.name,
                    profile = profile,
                    model = installedModel,
                    modelStatus = modelStatus,
                    inferenceAvailable = inferenceAvailable,
                    modelLoaded = modelLoaded,
                    modelBusy = modelBusy,
                    prompt = prompt,
                    assistantResponse = assistantResponse,
                    assistantMetrics = assistantMetrics,
                    assistantBusy = assistantBusy,
                    speechReady = speechReady,
                    speechStatus = speechStatus,
                    speechInputStatus = speechInputStatus,
                    onDeviceSpeechAvailable = onDeviceSpeechAvailable,
                    voiceListening = voiceListening,
                    microphonePermissionGranted = microphonePermissionGranted,
                    pairingNotice = pairingNotice,
                    onNavigate = { target ->
                        destination = runCatching { VanessaDestination.valueOf(target) }
                            .getOrDefault(VanessaDestination.HOME)
                        if (target == "PAIRING") pairingNotice = null
                    },
                    onPromptChange = { prompt = it },
                    onRunAssistant = { runAssistant(prompt) },
                    onSpeakRequest = ::requestSpeechInput,
                    onStopSpeech = ::stopSpeechInput,
                    onSpeakResponse = ::speakAssistantResponse,
                    onRefresh = ::refreshProfile,
                    onStartPairing = {
                        pairingNotice =
                            "Secure Windows pairing is not enabled in this Android build. No device has been paired."
                    },
                    onDismissPairingNotice = { pairingNotice = null },
                )
            }
        }

        offlineTts = OfflineTtsController(applicationContext) { ready, message ->
            runOnUiThread {
                speechReady = ready
                speechStatus = message
            }
        }

        onDeviceSpeechInput = AndroidOnDeviceSpeechInput(
            applicationContext,
            onTranscript = { transcript ->
                runOnUiThread {
                    destination = VanessaDestination.VOICE
                    prompt = transcript
                    voiceListening = false
                    runAssistant(transcript)
                }
            },
            onState = { state ->
                runOnUiThread {
                    speechInputStatus = state
                    voiceListening = state.contains("Listening", ignoreCase = true) &&
                        !state.contains("unavailable", ignoreCase = true) &&
                        !state.contains("failed", ignoreCase = true)
                }
            },
        )
        onDeviceSpeechAvailable = onDeviceSpeechInput?.isAvailable() == true
        speechInputStatus = if (onDeviceSpeechAvailable) {
            "On-device speech recognition is available for the current system language."
        } else {
            "On-device speech recognition is unavailable. Typed input remains available."
        }

        initializeRuntime()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putString("vanessa_destination", destination.name)
        outState.putString("vanessa_prompt", prompt)
        super.onSaveInstanceState(outState)
    }

    override fun onResume() {
        super.onResume()
        microphonePermissionGranted = hasMicrophonePermission()
        if (startupReady) refreshProfile()
    }

    override fun onDestroy() {
        offlineTts?.close()
        onDeviceSpeechInput?.close()
        offlineTts = null
        onDeviceSpeechInput = null
        super.onDestroy()
    }

    private fun initializeRuntime() {
        lifecycleScope.launch {
            startupMessage = "Checking this device…"
            val device = withContext(Dispatchers.IO) { profiler.snapshot() }

            startupMessage = "Detecting the installed local model…"
            val model = withContext(Dispatchers.IO) { modelManager.installedModel() }
            val engine = localInference()
            inferenceAvailable = engine.isAvailable
            modelBusy = model != null && engine.isAvailable && !engine.isModelLoaded

            val status: String
            if (model == null) {
                modelLoaded = false
                status = "No valid local GGUF model was found in app storage."
            } else if (!engine.isAvailable) {
                modelLoaded = false
                status = "A local model was detected, but the native inference runtime is unavailable on this device."
            } else if (engine.isModelLoaded) {
                modelLoaded = true
                status = "The installed local model is already loaded."
            } else {
                val modelSizeMb = model.bytes / (1024L * 1024L)
                val requiredRamMb = maxOf(1024L, modelSizeMb + 512L)
                if (device.ramAvailableMb < requiredRamMb) {
                    modelLoaded = false
                    status = "Model detected. Automatic loading was skipped because available memory is below the safe startup threshold."
                } else {
                    startupMessage = "Starting the local model…"
                    status = try {
                        withContext(Dispatchers.IO) { engine.loadModel(File(model.path)) }
                        modelLoaded = engine.isModelLoaded
                        if (modelLoaded) "The installed local model was detected and loaded automatically."
                        else "The model load did not complete. Local inference is unavailable."
                    } catch (error: Exception) {
                        modelLoaded = false
                        "Model detected, but loading failed: ${error.message ?: "unknown runtime error"}"
                    }
                }
            }

            installedModel = model
            modelStatus = status
            modelBusy = false
            inferenceAvailable = engine.isAvailable
            profile = device.copy(
                inferenceRuntimeInstalled = engine.isAvailable,
                modelLoadVerified = engine.isModelLoaded,
            )
            startupMessage = if (modelLoaded) "Vanessa is ready on this device."
            else "Vanessa is open. Some local features are unavailable."
            startupReady = true
        }
    }

    private fun localInference(): LlamaCppInference =
        inference ?: LlamaCppInference.getInstance(applicationContext).also { inference = it }

    private fun refreshProfile() {
        lifecycleScope.launch {
            val snapshot = withContext(Dispatchers.IO) {
                val engine = localInference()
                profiler.snapshot().copy(
                    inferenceRuntimeInstalled = engine.isAvailable,
                    modelLoadVerified = engine.isModelLoaded,
                )
            }
            profile = snapshot
            inferenceAvailable = snapshot.inferenceRuntimeInstalled
            modelLoaded = snapshot.modelLoadVerified
        }
    }

    private fun requestSpeechInput() {
        if (!onDeviceSpeechAvailable) {
            speechInputStatus = "No on-device recognizer is available. Type your request instead."
            return
        }
        if (hasMicrophonePermission()) startSpeechInput()
        else requestMicrophone.launch(Manifest.permission.RECORD_AUDIO)
    }

    private fun startSpeechInput() {
        if (onDeviceSpeechInput?.start() != true) {
            voiceListening = false
            speechInputStatus = "Could not start on-device speech recognition."
        } else {
            voiceListening = true
        }
    }

    private fun stopSpeechInput() {
        onDeviceSpeechInput?.stop()
        voiceListening = false
        speechInputStatus = "Listening stopped."
    }

    private fun speakAssistantResponse() {
        if (assistantResponse.isBlank() || offlineTts?.speak(assistantResponse) != true) {
            speechStatus = "An offline TTS voice is not ready. The text response is still available."
        }
    }

    private fun runAssistant(request: String) {
        val task = request.trim()
        if (task.isEmpty()) {
            assistantResponse = "Enter a request or use the microphone."
            return
        }
        if (!modelLoaded) {
            assistantResponse =
                "No local model is active. Vanessa has not run this request. Check the model and runtime status in Settings."
            return
        }
        if (assistantBusy) return

        assistantBusy = true
        assistantResponse = "Planning on this device…"
        assistantMetrics = ""
        lifecycleScope.launch {
            var awaitingPermission = false
            try {
                val engine = localInference()
                val coordinator = LocalPlanCoordinator(
                    inference = engine,
                    executor = AndroidLocalToolExecutor(profiler, calendarTool),
                )
                when (val outcome = withContext(Dispatchers.Default) { coordinator.run(task) }) {
                    is LocalPlanOutcome.Success -> {
                        assistantResponse = withContext(Dispatchers.Default) {
                            coordinator.respond(task, outcome.results)
                        }
                        engine.lastGenerationMetrics?.let {
                            assistantMetrics =
                                "Last generation: ${it.ttftMs} ms TTFT · " +
                                String.format(Locale.ROOT, "%.1f", it.tokensPerSecond) + " tokens/s"
                        }
                    }
                    is LocalPlanOutcome.Failure -> {
                        if (outcome.error == LocalPlanError.PERMISSION_REQUIRED &&
                            !hasCalendarPermission()
                        ) {
                            pendingAgentPrompt = task
                            assistantResponse =
                                "Vanessa needs calendar access for this request. Android will ask for permission."
                            awaitingPermission = true
                            requestCalendar.launch(Manifest.permission.READ_CALENDAR)
                        } else {
                            assistantResponse = outcome.reason
                        }
                    }
                }
            } catch (error: Exception) {
                assistantResponse =
                    "The local task could not be completed: ${error.message ?: "unknown error"}"
            } finally {
                if (!awaitingPermission) assistantBusy = false
            }
        }
    }

    private fun hasCalendarPermission(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.READ_CALENDAR) ==
            PackageManager.PERMISSION_GRANTED

    private fun hasMicrophonePermission(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
}
