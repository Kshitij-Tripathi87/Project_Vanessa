package com.vanessa.mobile.ui

import ai.vanessa.agent.CaptureLease
import ai.vanessa.agent.ConversationController
import ai.vanessa.agent.ConversationPublishResult
import ai.vanessa.agent.ConversationRequestHandle
import ai.vanessa.agent.LocalPlanCoordinator
import ai.vanessa.agent.LocalPlanError
import ai.vanessa.agent.LocalPlanOutcome
import android.Manifest
import android.content.Context
import android.content.Intent
import android.net.Uri
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
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.lifecycleScope
import com.vanessa.mobile.agent.AndroidLocalToolExecutor
import com.vanessa.mobile.inference.LlamaCppInference
import com.vanessa.mobile.model.InstalledModel
import com.vanessa.mobile.model.ModelManager
import com.vanessa.mobile.profile.AndroidDeviceProfiler
import com.vanessa.mobile.profile.DeviceProfile
import com.vanessa.mobile.tools.CalendarSearchTool
import com.vanessa.mobile.voice.AndroidOnDeviceSpeechInput
import com.vanessa.mobile.voice.MicrophonePermissionState
import com.vanessa.mobile.voice.OfflineTtsController
import com.vanessa.mobile.voice.OfflineTtsPlaybackStatus
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.util.Locale
import com.vanessa.mobile.ui.theme.VanessaTheme
import com.vanessa.protocol.conversation.ConversationTurnSource
import java.util.UUID
import kotlinx.coroutines.flow.collect

private enum class VanessaDestination {
    WELCOME,
    ONBOARDING,
    PERMISSIONS,
    HOME,
    LISTENING,
    CONFIRM,
    EXECUTING,
    SUCCESS,
    PAIRING,
    PC,
    SETTINGS,
}

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
    private val conversationController = ConversationController(UUID.randomUUID().toString())
    private var conversationState by mutableStateOf(conversationController.state.value)

    /** UI is a projection of reducer state; no parallel transcript/draft is stored here. */
    private val chatMessages: List<VanessaChatMessage>
        get() = ConversationUiProjection.messages(conversationState)

    private val voiceDraft: String
        get() = ConversationUiProjection.voiceDraft(conversationState)

    private var activeCaptureLease: CaptureLease? = null
    private val microphonePermissionGate by lazy {
        ViewModelProvider(this)[MicrophonePermissionState::class.java].gate
    }
    private var pendingConversationRequest: ConversationRequestHandle? = null
    private var assistantResponse by mutableStateOf("")
    private var assistantMetrics by mutableStateOf("")
    private var assistantBusy by mutableStateOf(false)
    private var speechStatus by mutableStateOf("Checking offline speech output…")
    private var speechPlaybackStatus by mutableStateOf(OfflineTtsPlaybackStatus.IDLE)

    private var speechReady by mutableStateOf(false)
    private var speechInputStatus by mutableStateOf("Checking on-device speech support…")
    private var onDeviceSpeechAvailable by mutableStateOf(false)
    private var voiceListening by mutableStateOf(false)
    private var microphonePermissionGranted by mutableStateOf(false)
    private var pairingNotice by mutableStateOf<String?>(null)
    private var modelImportBusy by mutableStateOf(false)
    private var modelImportMessage by mutableStateOf("Models are stored privately on this device. Select a GGUF file to install it.")
    private var pendingModelChecksum: String? = null
    private var approval by mutableStateOf<ApprovalRequest?>(null)
    private var execution by mutableStateOf<ExecutionState?>(null)
    private var completion by mutableStateOf(
        CompletionState(title = "All set!", body = "Your request is complete.", detail = null),
    )
    /** Checksum the user typed, held while an approval is pending. */
    private var pendingApprovalChecksum: String? = null
    private val setupPermissionQueue = ArrayDeque<String>()

    private val onboardingPreferences by lazy {
        getSharedPreferences("vanessa_onboarding", Context.MODE_PRIVATE)
    }

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
                destination = VanessaDestination.HOME
                val request = pendingConversationRequest
                if (granted && request != null) {
                    runAssistant(retry, requestHandle = request)
                } else {
                    assistantResponse = "Calendar permission was denied. Vanessa did not read any calendar events."
                    request?.let { publishAssistantResponse(it, assistantResponse) }
                    pendingConversationRequest = null
                }
            }
        }

    private val requestMicrophone =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            microphonePermissionGranted = granted
            val requested = microphonePermissionGate.resolve(granted)
            if (requested && destination == VanessaDestination.LISTENING &&
                lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)
            ) {
                startSpeechInput()
            } else if (destination == VanessaDestination.LISTENING) {
                voiceListening = false
                speechInputStatus = if (granted) {
                    "Voice input was interrupted before permission returned. Start it again if you want to speak."
                } else {
                    "Microphone permission denied. You can type your request instead."
                }
            }
        }

    private val requestSetupPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { _ ->
            // Refresh before continuing so the permissions screen reflects the
            // answer it just received, then ask for the next one.
            microphonePermissionGranted = hasMicrophonePermission()
            refreshProfile()
            runSetupPermissionQueue()
        }

    private val requestModelDocument =
        registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
            val expectedChecksum = pendingModelChecksum
            pendingModelChecksum = null
            if (uri == null) {
                modelImportMessage = "Model selection cancelled."
                if (destination == VanessaDestination.EXECUTING) {
                    execution = null
                    destination = VanessaDestination.SETTINGS
                }
            } else {
                importModel(uri, expectedChecksum)
            }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        destination = savedInstanceState?.getString("vanessa_destination")
            ?.let { runCatching { VanessaDestination.valueOf(it) }.getOrNull() }
            ?: if (onboardingComplete()) VanessaDestination.HOME else VanessaDestination.WELCOME
        prompt = savedInstanceState?.getString("vanessa_prompt").orEmpty()
        window.statusBarColor = android.graphics.Color.rgb(3, 5, 10)
        window.navigationBarColor = android.graphics.Color.rgb(3, 5, 10)
        microphonePermissionGranted = hasMicrophonePermission()
        lifecycleScope.launch {
            conversationController.state.collect { state ->
                conversationState = state
            }
        }

        setContent {
            VanessaTheme {
                // The welcome screen is the activity's first screen, so back
                // there is left to the system (it exits) rather than trapped.
                BackHandler(
                    enabled = startupReady && destination != VanessaDestination.WELCOME &&
                        destination != VanessaDestination.HOME,
                ) {
                    when (destination) {
                        VanessaDestination.ONBOARDING -> destination = VanessaDestination.WELCOME
                        VanessaDestination.PERMISSIONS -> destination = VanessaDestination.ONBOARDING
                        VanessaDestination.LISTENING -> {
                            cancelSpeechInput()
                            destination = VanessaDestination.HOME
                        }
                        // One cancel path, not two. Back used to clear the same
                        // state by hand and could drift from the Cancel button.
                        VanessaDestination.CONFIRM -> cancelPendingAction()
                        // Work in progress is not cancellable from the route:
                        // leaving mid-run would strand the result.
                        VanessaDestination.EXECUTING -> Unit
                        VanessaDestination.SUCCESS -> destination = VanessaDestination.HOME
                        VanessaDestination.PAIRING -> destination = VanessaDestination.PC
                        VanessaDestination.PC, VanessaDestination.SETTINGS -> destination = VanessaDestination.HOME
                        else -> destination = VanessaDestination.HOME
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
                    chatMessages = chatMessages,
                    assistantResponse = assistantResponse,
                    assistantMetrics = assistantMetrics,
                    assistantBusy = assistantBusy,
                    speechReady = speechReady,
                    speechStatus = speechStatus,
                    speechPlaybackStatus = speechPlaybackStatus,
                    speechInputStatus = speechInputStatus,
                    voiceDraft = voiceDraft,
                    onDeviceSpeechAvailable = onDeviceSpeechAvailable,
                    voiceListening = voiceListening,
                    microphonePermissionGranted = microphonePermissionGranted,
                    modelImportBusy = modelImportBusy,
                    modelImportMessage = modelImportMessage,
                    pairingNotice = pairingNotice,
                    onNavigate = { target ->
                        destination = runCatching { VanessaDestination.valueOf(target) }
                            .getOrDefault(VanessaDestination.HOME)
                        if (target == "PAIRING") pairingNotice = null
                    },
                    onPromptChange = { prompt = it },
                    onRunAssistant = {
                        val submitted = prompt.trim()
                        prompt = ""
                        runAssistant(submitted)
                    },
                    onSpeakRequest = {
                        // An explicit microphone request preempts read-aloud only.
                        // It does not cancel any conversation task.
                        offlineTts?.stop()
                        destination = VanessaDestination.LISTENING
                        requestSpeechInput()
                    },
                    onStopSpeech = ::stopSpeechInput,
                    onCancelSpeech = ::cancelSpeechInput,
                    onSpeakResponse = ::speakAssistantResponse,
                    onStopSpeechOutput = ::stopSpeakingResponse,
                    onRefresh = ::refreshProfile,
                    onImportModel = { checksum ->
                        val installed = installedModel
                        if (installed == null) {
                            // Nothing to destroy on a first install.
                            chooseModel(checksum)
                        } else {
                            pendingApprovalChecksum = checksum
                            approval = ApprovalRequest(
                                title = "Confirm Action",
                                body = "Vanessa will replace the installed local model. The current file is kept unless the selected one validates.",
                                detail = "Current model: ${File(installed.path).name}",
                                approveLabel = "Approve",
                            )
                            destination = VanessaDestination.CONFIRM
                        }
                    },
                    onStartPairing = {
                        pairingNotice = null
                        startActivity(Intent(this, RemoteControlActivity::class.java))
                    },
                    onDismissPairingNotice = { pairingNotice = null },
                    approval = approval,
                    execution = execution,
                    completion = completion,
                    onCompleteOnboarding = {
                        markOnboardingComplete()
                        approval = null
                        destination = VanessaDestination.HOME
                    },
                    onRequestPermissions = {
                        requestSetupPermissions(
                            listOf(Manifest.permission.RECORD_AUDIO),
                        )
                    },
                    onApprove = ::approvePendingAction,
                    onCancelApproval = ::cancelPendingAction,
                )
            }
        }

        offlineTts = OfflineTtsController(
            context = applicationContext,
            onState = { ready, message ->
                runOnUiThread {
                    speechReady = ready
                    speechStatus = message
                }
            },
            onPlaybackEvent = { event ->
                runOnUiThread {
                    speechPlaybackStatus = event.status
                    speechStatus = event.detail ?: when (event.status) {
                        OfflineTtsPlaybackStatus.IDLE -> speechStatus
                        OfflineTtsPlaybackStatus.STARTING -> "Preparing offline speech…"
                        OfflineTtsPlaybackStatus.SPEAKING -> "Reading response aloud…"
                        OfflineTtsPlaybackStatus.COMPLETED -> "Read-aloud finished."
                        OfflineTtsPlaybackStatus.STOPPED -> "Read-aloud stopped."
                        OfflineTtsPlaybackStatus.ERROR -> "Offline speech playback failed. The text response remains available."
                    }
                }
            },
        )

        onDeviceSpeechInput = AndroidOnDeviceSpeechInput(
            applicationContext,
            onTranscript = { transcript ->
                runOnUiThread {
                    val lease = activeCaptureLease
                    activeCaptureLease = null
                    val request = lease?.let { conversationController.publishFinal(it, transcript) }
                    if (request == null) {
                        speechInputStatus = "The recognized utterance was no longer active. No request was submitted."
                        voiceListening = false
                        return@runOnUiThread
                    }

                    // The final ASR result commits the existing voice turn. It
                    // enters the same local assistant path as a typed request.
                    destination = VanessaDestination.HOME
                    prompt = ""
                    voiceListening = false
                    runAssistant(transcript, requestHandle = request)
                }
            },
            onPartial = { draft ->
                runOnUiThread {
                    activeCaptureLease?.let { lease ->
                        conversationController.publishPartial(lease, draft)
                    }
                }
            },
            onState = { state ->
                runOnUiThread {
                    val normalized = state.lowercase(Locale.ROOT)
                    if (
                        normalized.contains("failed") ||
                        normalized.contains("no speech was recognized") ||
                        normalized.contains("could not start") ||
                        normalized.contains("could not finish")
                    ) {
                        activeCaptureLease?.let { lease ->
                            conversationController.failCapture(lease, state)
                        }
                        activeCaptureLease = null
                    }
                    speechInputStatus = state
                    voiceListening = (
                        normalized.contains("listening") ||
                            normalized.contains("processing speech")
                        ) &&
                        !normalized.contains("unavailable") &&
                        !normalized.contains("failed")
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

    override fun onStop() {
        // No speech capture continues in the background. A pending permission
        // result is invalidated too, so returning to the app cannot start an
        // abandoned microphone request behind the user's back.
        if (activeCaptureLease != null || microphonePermissionGate.isPending) cancelSpeechInput()
        super.onStop()
    }

    override fun onDestroy() {
        microphonePermissionGate.cancel()
        activeCaptureLease?.let { conversationController.cancelCapture(it) }
        activeCaptureLease = null
        offlineTts?.close()
        onDeviceSpeechInput?.close()
        offlineTts = null
        onDeviceSpeechInput = null
        super.onDestroy()
    }

    /**
     * Startup must always finish. Every probe here talks to the platform — the
     * device profile, app storage, the native runtime — and any of them can throw
     * on a device the build was not tested against. Previously a single throw left
     * `startupReady` false, which parks the app on the splash screen forever with
     * no message and no way forward. A first-run emulator test caught it: five
     * journeys all timed out waiting for the welcome screen to appear.
     *
     * A failed probe is now reported and the app opens with the affected features
     * unavailable, which is the same contract the rest of the surface follows.
     */
    private fun initializeRuntime() {
        lifecycleScope.launch {
            try {
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
            } catch (cancelled: kotlinx.coroutines.CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                // Report, do not trap. The surface says what is unavailable.
                modelLoaded = false
                modelBusy = false
                inferenceAvailable = false
                modelStatus = "The startup check did not finish: " +
                    (error.message ?: error::class.java.simpleName) +
                    ". Local features are unavailable until this is resolved."
                installedModel = null
                startupMessage = "Vanessa is open. Some local features are unavailable."
            } finally {
                startupReady = true
            }
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

    private fun chooseModel(expectedSha256: String) {
        if (modelImportBusy || assistantBusy) {
            modelImportMessage = "Finish the current local task before replacing the model."
            return
        }
        pendingModelChecksum = expectedSha256.trim().takeIf { it.isNotEmpty() }
        modelImportMessage = "Choose a GGUF file. The selected file is verified before installation."
        requestModelDocument.launch(arrayOf("*/*"))
    }

    private fun importModel(uri: Uri, expectedSha256: String?) {
        if (modelImportBusy || assistantBusy) {
            modelImportMessage = "Finish the current local task before replacing the model."
            return
        }
        modelImportBusy = true
        modelBusy = true
        modelImportMessage = "Copying and validating the selected GGUF file…"
        execution = ExecutionState(
            title = "Replacing the local model",
            subtitle = "Copying and validating the selected GGUF file",
            steps = listOf(FlowStep("Copy and validate the selected GGUF", FlowStepState.ACTIVE)),
        )
        destination = VanessaDestination.EXECUTING

        lifecycleScope.launch {
            var succeeded = false
            try {
                when (val result = withContext(Dispatchers.IO) {
                    modelManager.importModel(uri, expectedSha256)
                }) {
                    is com.vanessa.mobile.model.ModelImportResult.Success -> {
                        val imported = result.model
                        installedModel = imported
                        val engine = localInference()
                        inferenceAvailable = engine.isAvailable
                        val checksumStatus = if (!expectedSha256.isNullOrBlank()) {
                            "Expected SHA-256 matched."
                        } else {
                            "SHA-256 calculated; no expected checksum was supplied."
                        }

                        if (!engine.isAvailable) {
                            modelLoaded = false
                            modelStatus = "The GGUF was imported and validated, but the native inference runtime is unavailable on this device."
                            modelImportMessage = "Imported and validated. $checksumStatus SHA-256: ${imported.sha256}"
                        } else if (result.alreadyInstalled && engine.isModelLoaded) {
                            modelLoaded = true
                            modelStatus = "The installed local model is already loaded."
                            modelImportMessage = "This exact model was already installed and is loaded. $checksumStatus SHA-256: ${imported.sha256}"
                        } else {
                            // Replacing a loaded model must release its memory before
                            // the new model's conservative RAM gate is evaluated.
                            if (engine.isModelLoaded) {
                                withContext(Dispatchers.IO) { engine.close() }
                                inference = null
                                modelLoaded = false
                            }

                            val loadEngine = localInference()
                            inferenceAvailable = loadEngine.isAvailable
                            if (!loadEngine.isAvailable) {
                                modelLoaded = false
                                modelStatus = "The GGUF was imported, but the native inference runtime is unavailable on this device."
                                modelImportMessage = "Imported and validated. The native runtime is unavailable. SHA-256: ${imported.sha256}"
                            } else {
                                val device = withContext(Dispatchers.IO) { profiler.snapshot() }
                                val modelSizeMb = imported.bytes / (1024L * 1024L)
                                val requiredRamMb = maxOf(1024L, modelSizeMb + 512L)
                                if (device.ramAvailableMb < requiredRamMb) {
                                    modelLoaded = false
                                    modelStatus = "The GGUF is installed, but loading was skipped because available memory is below the safe startup threshold ($requiredRamMb MB required)."
                                    modelImportMessage = "Imported and validated, but not loaded because available memory is too low. $checksumStatus SHA-256: ${imported.sha256}"
                                } else {
                                    execution = ExecutionState(
                                        title = "Replacing the local model",
                                        subtitle = "Loading the imported model on this device",
                                        steps = listOf(
                                            FlowStep("Copy and validate the selected GGUF", FlowStepState.DONE),
                                            FlowStep("Load on this device", FlowStepState.ACTIVE),
                                        ),
                                    )
                                    modelStatus = "Loading the imported local model…"
                                    withContext(Dispatchers.IO) { loadEngine.loadModel(File(imported.path)) }
                                    modelLoaded = loadEngine.isModelLoaded
                                    check(modelLoaded) { "The native runtime did not confirm that the imported model loaded." }
                                    modelStatus = "The imported local model is loaded and ready for inference."
                                    modelImportMessage = "Imported, validated, and loaded successfully. $checksumStatus SHA-256: ${imported.sha256}"
                                }
                            }
                        }

                        profile = withContext(Dispatchers.IO) {
                            profiler.snapshot().copy(
                                inferenceRuntimeInstalled = inferenceAvailable,
                                modelLoadVerified = modelLoaded,
                            )
                        }

                        succeeded = true
                        completion = CompletionState(
                            title = "All set!",
                            body = if (modelLoaded) {
                                "The local model is installed and loaded on this device."
                            } else {
                                "The model is installed and validated, but it is not loaded."
                            },
                            detail = "SHA-256: " + imported.sha256.take(24) + "…",
                        )
                    }
                    is com.vanessa.mobile.model.ModelImportResult.Failure -> {
                        modelImportMessage = "Import failed: ${result.reason}. The previous installed model was not replaced."
                    }
                    com.vanessa.mobile.model.ModelImportResult.Cancelled -> {
                        modelImportMessage = "Model import cancelled. The previous installed model was not replaced."
                    }
                }
            } catch (error: Exception) {
                modelLoaded = inference?.isModelLoaded == true
                modelStatus = if (modelLoaded) {
                    "The previously loaded model remains available."
                } else {
                    "The model is installed, but the native runtime could not load it."
                }
                modelImportMessage = "Model import/load failed: ${error.message ?: "unknown error"}"
            } finally {
                modelBusy = false
                modelImportBusy = false
                execution = null
                if (destination == VanessaDestination.EXECUTING) {
                    destination = if (succeeded) VanessaDestination.SUCCESS else VanessaDestination.SETTINGS
                }
            }
        }
    }

    private fun requestSpeechInput() {
        if (!onDeviceSpeechAvailable) {
            speechInputStatus = "No on-device recognizer is available. Type your request instead."
            return
        }
        if (microphonePermissionGate.isPending) {
            speechInputStatus = "Wait for the previous microphone permission request to finish."
            return
        }
        if (hasMicrophonePermission()) {
            startSpeechInput()
        } else if (microphonePermissionGate.begin()) {
            try {
                requestMicrophone.launch(Manifest.permission.RECORD_AUDIO)
            } catch (_: Exception) {
                microphonePermissionGate.resolve(false)
                speechInputStatus = "Could not request microphone permission. You can type your request instead."
            }
        }
    }

    private fun startSpeechInput() {
        if (destination != VanessaDestination.LISTENING ||
            !lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED) || !hasMicrophonePermission()
        ) {
            voiceListening = false
            speechInputStatus = "Voice input is no longer active. Start it again if you want to speak."
            return
        }
        // Each recognizer start receives a fresh lease. Any late callback from
        // an older recognizer generation is rejected by ConversationController.
        activeCaptureLease?.let { conversationController.cancelCapture(it) }
        val lease = conversationController.beginCapture(ConversationTurnSource.VOICE)
        activeCaptureLease = lease
        if (onDeviceSpeechInput?.start() != true) {
            conversationController.failCapture(lease, "On-device speech recognition could not start.")
            activeCaptureLease = null
            voiceListening = false
            speechInputStatus = "Could not start on-device speech recognition."
        } else {
            voiceListening = true
        }
    }

    /** StopListening asks Android for a final result; it is not a cancellation. */
    private fun stopSpeechInput() {
        onDeviceSpeechInput?.stop()
        voiceListening = false
        speechInputStatus = "Finishing the on-device transcript…"
    }

    /** Navigation/Type Instead invalidates the capture lease before recognizer teardown. */
    private fun cancelSpeechInput() {
        microphonePermissionGate.cancel()
        activeCaptureLease?.let { conversationController.cancelCapture(it) }
        activeCaptureLease = null
        onDeviceSpeechInput?.close()
        voiceListening = false
        speechInputStatus = "Voice input cancelled. You can type your request."
    }

    private fun speakAssistantResponse() {
        val responseText = conversationState.turns.lastOrNull { turn ->
            turn.role == com.vanessa.protocol.conversation.ConversationTurnRole.ASSISTANT &&
                turn.isFinal
        }?.text?.takeIf { it.isNotBlank() } ?: assistantResponse

        if (responseText.isBlank() || offlineTts?.speak(responseText) != true) {
            speechPlaybackStatus = OfflineTtsPlaybackStatus.ERROR
            speechStatus = "Offline speech could not start. The text response remains available."
        }
    }

    private fun stopSpeakingResponse() {
        if (offlineTts?.stop() != true) {
            speechStatus = "No read-aloud playback is active."
        }
    }

    private fun publishAssistantResponse(request: ConversationRequestHandle, response: String): Boolean {
        val assistantTurn = conversationController.beginAssistantTurn(request)
        if (assistantTurn == null) {
            speechInputStatus = "The assistant response could not be attached to its originating conversation turn."
            return false
        }
        return when (conversationController.publishValidatedResponse(assistantTurn, response)) {
            ConversationPublishResult.PUBLISHED -> true
            ConversationPublishResult.INVALID -> false // The reducer has already failed the assistant turn.
            ConversationPublishResult.STALE,
            ConversationPublishResult.IGNORED -> {
                speechInputStatus = "The assistant response was stale and was not added to the conversation."
                false
            }
        }
    }

    private fun runAssistant(
        request: String,
        requestHandle: ConversationRequestHandle? = null,
    ) {
        val task = request.trim()
        if (task.isEmpty()) {
            assistantResponse = "Enter a request or use the microphone."
            return
        }

        val conversationRequest = requestHandle ?: conversationController.submitTyped(task)
        if (conversationRequest == null) {
            assistantResponse = "A conversation turn could not be created. The existing conversation is unchanged."
            return
        }

        // A new user request must not overlap speech from the previous response.
        // This stops TTS playback only; task execution remains owned by its supervisor.
        offlineTts?.stop()

        if (assistantBusy) {
            assistantResponse = "Vanessa is already completing another request on this device."
            publishAssistantResponse(
                conversationRequest,
                "This request was not run because another local request was still active. Please submit it again.",
            )
            return
        }

        pendingConversationRequest = null
        if (modelBusy) {
            assistantResponse = "The local model is being installed or loaded. Try again when that operation finishes."
            publishAssistantResponse(conversationRequest, assistantResponse)
            return
        }
        if (!modelLoaded) {
            assistantResponse =
                "No local model is active. Vanessa has not run this request. Check the model and runtime status in Settings."
            publishAssistantResponse(conversationRequest, assistantResponse)
            return
        }

        // The controller provides only completed historical turns and excludes
        // this request ID. ASR partials and the current request never enter the
        // planner's history.
        val conversationContext = conversationController.plannerContext(
            excludingRequestId = conversationRequest.requestId,
        )

        assistantBusy = true
        assistantResponse = "Planning on this device…"
        assistantMetrics = ""
        val startedFromChat = destination == VanessaDestination.HOME ||
            destination == VanessaDestination.LISTENING
        if (startedFromChat) {
            execution = ExecutionState(
                title = "Executing Task…",
                subtitle = "Running your request on this device",
                steps = listOf(FlowStep("On-device model", FlowStepState.ACTIVE)),
            )
            destination = VanessaDestination.EXECUTING
        }
        lifecycleScope.launch {
            var awaitingPermission = false
            var succeeded = false
            try {
                val engine = localInference()
                val coordinator = LocalPlanCoordinator(
                    inference = engine,
                    executor = AndroidLocalToolExecutor(profiler, calendarTool),
                )
                when (
                    val outcome = withContext(Dispatchers.Default) {
                        coordinator.run(task, conversationContext)
                    }
                ) {
                    is LocalPlanOutcome.Success -> {
                        val response = withContext(Dispatchers.Default) {
                            coordinator.respond(task, outcome.results)
                        }
                        assistantResponse = response
                        succeeded = publishAssistantResponse(conversationRequest, response)
                        engine.lastGenerationMetrics?.let {
                            assistantMetrics =
                                "Last generation: ${it.ttftMs} ms TTFT · " +
                                    String.format(Locale.ROOT, "%.1f", it.tokensPerSecond) + " tokens/s"
                        }
                        completion = CompletionState(
                            title = if (succeeded) "All set!" else "Response not verified",
                            body = if (succeeded) {
                                "Your request is complete."
                            } else {
                                "The local result was produced, but Vanessa could not commit a valid conversation response."
                            },
                            detail = assistantMetrics.ifBlank { null },
                        )
                    }
                    is LocalPlanOutcome.Failure -> {
                        if (
                            outcome.error == LocalPlanError.PERMISSION_REQUIRED &&
                            !hasCalendarPermission()
                        ) {
                            pendingAgentPrompt = task
                            pendingConversationRequest = conversationRequest
                            assistantResponse =
                                "Vanessa needs calendar access for this request. Android will ask for permission."
                            awaitingPermission = true
                            execution = null
                            destination = VanessaDestination.HOME
                            requestCalendar.launch(Manifest.permission.READ_CALENDAR)
                        } else {
                            assistantResponse = outcome.reason
                            publishAssistantResponse(conversationRequest, assistantResponse)
                        }
                    }
                }
            } catch (cancelled: kotlinx.coroutines.CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                assistantResponse =
                    "The local task could not be completed: ${error.message ?: "unknown error"}"
                publishAssistantResponse(conversationRequest, assistantResponse)
            } finally {
                if (!awaitingPermission) {
                    if (pendingConversationRequest == conversationRequest) {
                        pendingConversationRequest = null
                        pendingAgentPrompt = null
                    }
                    assistantBusy = false
                    execution = null
                    // Only advance the route if the user is still watching this
                    // run. If they closed it, the outcome stays in the chat and
                    // is not pushed in front of them.
                    if (startedFromChat && destination == VanessaDestination.EXECUTING) {
                        destination = if (succeeded) VanessaDestination.SUCCESS else VanessaDestination.HOME
                    }
                }
            }
        }
    }

    private fun onboardingComplete(): Boolean =
        onboardingPreferences.getBoolean("complete", false)

    private fun markOnboardingComplete() {
        onboardingPreferences.edit().putBoolean("complete", true).apply()
    }

    /**
     * Asks for setup permissions one at a time. Launching two permission
     * requests back to back would replace the first pending request, so the
     * queue advances only from the launcher's callback.
     */
    private fun requestSetupPermissions(permissions: List<String>) {
        setupPermissionQueue.clear()
        setupPermissionQueue.addAll(permissions)
        runSetupPermissionQueue()
    }

    private fun runSetupPermissionQueue() {
        while (setupPermissionQueue.isNotEmpty()) {
            val permission = setupPermissionQueue.removeFirst()
            if (ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED) {
                continue
            }
            requestSetupPermission.launch(permission)
            return
        }
        microphonePermissionGranted = hasMicrophonePermission()
        refreshProfile()
    }

    /**
     * The user approved replacing the installed model. The checksum they typed
     * is carried through the approval, so approving cannot silently drop it.
     */
    private fun approvePendingAction() {
        val checksum = pendingApprovalChecksum.orEmpty()
        pendingApprovalChecksum = null
        approval = null

        if (modelImportBusy || assistantBusy) {
            modelImportMessage = "Finish the current local task before replacing the model."
            destination = VanessaDestination.SETTINGS
            return
        }

        execution = ExecutionState(
            title = "Replacing the local model",
            subtitle = "Waiting for you to choose a GGUF file",
            steps = listOf(FlowStep("Copy and validate the selected GGUF", FlowStepState.ACTIVE)),
        )
        destination = VanessaDestination.EXECUTING
        chooseModel(checksum)
    }

    /**
     * Drops a local confirmation that the user has not committed to. Nothing is
     * pending on any PC — this is a screen gate in front of a local file import —
     * so cancelling is complete in itself.
     */
    private fun cancelPendingAction() {
        pendingApprovalChecksum = null
        approval = null
        destination = VanessaDestination.SETTINGS
    }

    private fun hasCalendarPermission(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.READ_CALENDAR) ==
            PackageManager.PERMISSION_GRANTED

    private fun hasMicrophonePermission(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
}
