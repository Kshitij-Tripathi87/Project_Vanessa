package com.vanessa.mobile.ui

import ai.vanessa.agent.LocalPlanCoordinator
import ai.vanessa.agent.LocalPlanOutcome
import ai.vanessa.agent.LocalPlanError
import android.Manifest
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import androidx.fragment.app.FragmentActivity
import dagger.hilt.android.AndroidEntryPoint
import javax.inject.Inject
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.colorResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.google.android.gms.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.android.gms.mlkit.vision.codescanner.GmsBarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.vanessa.mobile.R
import com.vanessa.mobile.di.PairingRepository
import com.vanessa.mobile.di.StoredRemoteV2Pairing
import com.vanessa.mobile.identity.AndroidBiometricApprovalKeyStore
import com.vanessa.mobile.pairing.RemoteV2PairingConfiguration
import com.vanessa.mobile.pairing.RemoteV2PairingPayloadParser
import com.vanessa.mobile.pairing.RemoteV2PairingPayloadResult
import com.vanessa.mobile.remote.RemoteV2Client
import com.vanessa.mobile.remote.RemoteV2LiveSession
import com.vanessa.mobile.agent.AndroidLocalToolExecutor
import com.vanessa.mobile.inference.LlamaCppInference
import com.vanessa.mobile.model.InstalledModel
import com.vanessa.mobile.model.ModelImportResult
import com.vanessa.mobile.model.ModelManager
import com.vanessa.mobile.profile.AndroidDeviceProfiler
import com.vanessa.mobile.profile.DeviceProfile
import com.vanessa.mobile.profile.OperatingMode
import com.vanessa.mobile.tools.CalendarMeeting
import com.vanessa.mobile.tools.CalendarSearchResult
import com.vanessa.mobile.tools.CalendarSearchTool
import com.vanessa.mobile.voice.AndroidOnDeviceSpeechInput
import com.vanessa.mobile.voice.OfflineTtsController
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.collect
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.io.File
import java.text.DateFormat
import java.util.Date

/** Local-first assistant with an authenticated v2 Windows-PC remote session. */
@AndroidEntryPoint
class MainActivity : FragmentActivity() {
    @Inject lateinit var pairingRepository: PairingRepository
    private fun newRemoteClient() = RemoteV2Client()
    private var remoteSession: RemoteV2LiveSession? = null
    private var remoteEventsJob: Job? = null
    private var remoteQrJson by mutableStateOf("")
    private var remoteStatus by mutableStateOf("No Windows PC paired.")
    private var remoteBusy by mutableStateOf(false)
    private var remoteOpenUrl by mutableStateOf("https://www.google.com")
    private var remoteTaskStatus by mutableStateOf("")
    private var remotePendingApproval by mutableStateOf<JsonObject?>(null)
    private var profile by mutableStateOf<DeviceProfile?>(null)
    private val profiler by lazy { AndroidDeviceProfiler(applicationContext) }
    private val calendarTool by lazy { CalendarSearchTool(applicationContext) }
    private val modelManager by lazy { ModelManager(applicationContext) }

    private var installedModel by mutableStateOf<InstalledModel?>(null)
    private var modelStatus by mutableStateOf("Checking local model storage…")
    private var inferenceAvailable by mutableStateOf(false)
    private var modelLoaded by mutableStateOf(false)
    private var modelBusy by mutableStateOf(false)
    private var prompt by mutableStateOf("")
    private var assistantResponse by mutableStateOf("")
    private var assistantMetrics by mutableStateOf("")
    private var assistantBusy by mutableStateOf(false)
    private var speechStatus by mutableStateOf("Initializing offline speech…")
    private var speechReady by mutableStateOf(false)
    private var speechInputStatus by mutableStateOf("Checking on-device speech support…")
    private var onDeviceSpeechAvailable by mutableStateOf(false)
    private var offlineTts: OfflineTtsController? = null
    private var onDeviceSpeechInput: AndroidOnDeviceSpeechInput? = null
    private var pendingAgentPrompt: String? = null
    private var inference: LlamaCppInference? = null

    private var meetings by mutableStateOf<List<CalendarMeeting>>(emptyList())
    private var calendarMessage by mutableStateOf<String?>(null)
    private var calendarJob: Job? = null

    private val requestCalendar = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        refreshProfile()
        val retry = pendingAgentPrompt
        pendingAgentPrompt = null
        if (retry != null) {
            // The previous attempt remains busy while the system permission UI is open.
            // Clear it before starting the retried plan or runAssistant will reject it.
            assistantBusy = false
            if (granted) runAssistant(retry)
            else {
                assistantResponse = "Calendar permission was denied. Vanessa did not read any calendar events."
            }
        } else if (granted) {
            searchCalendar()
        } else {
            meetings = emptyList()
            calendarMessage = "Calendar permission denied. No events were read."
        }
    }

    private val openModel = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) importModel(uri)
    }

    private val requestMicrophone = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) startSpeechInput()
        else speechInputStatus = "Microphone permission denied. You can type your request instead."
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme(
                colorScheme = darkColorScheme(
                    primary = colorResource(R.color.vanessa_primary),
                    secondary = colorResource(R.color.vanessa_secondary),
                    background = colorResource(R.color.vanessa_background),
                    surface = colorResource(R.color.vanessa_surface),
                    onPrimary = colorResource(R.color.vanessa_on_primary),
                    onSurface = colorResource(R.color.vanessa_on_surface),
                    error = colorResource(R.color.vanessa_error),
                )
            ) {
                Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    DeviceScreen(
                        profile = profile,
                        installedModel = installedModel,
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
                        meetings = meetings,
                        calendarMessage = calendarMessage,
                        remoteQrJson = remoteQrJson,
                        remoteStatus = remoteStatus,
                        remoteBusy = remoteBusy,
                        remoteOpenUrl = remoteOpenUrl,
                        remoteTaskStatus = remoteTaskStatus,
                        remotePendingApproval = remotePendingApproval,
                        onRemoteQrChange = { remoteQrJson = it },
                        onPairRemote = ::pairRemote,
                        onScanRemoteQr = ::scanRemotePairingQr,
                        onReconnectRemote = ::restoreRemoteSession,
                        onRemoteUrlChange = { remoteOpenUrl = it },
                        onOpenRemoteUrl = ::openRemoteUrl,
                        onApproveRemote = ::approveRemoteAction,
                        onDenyRemote = ::denyRemoteAction,
                        onRefresh = ::refreshProfile,
                        onImportModel = ::chooseModel,
                        onLoadModel = ::loadModel,
                        onUnloadModel = ::unloadModel,
                        onPromptChange = { prompt = it },
                        onRunAssistant = { runAssistant(prompt) },
                        onSpeakRequest = ::requestSpeechInput,
                        onSpeakResponse = ::speakAssistantResponse,
                        onReadCalendar = ::requestMeetings,
                    )
                }
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
                prompt = transcript
                runAssistant(transcript)
            },
            onState = { state -> runOnUiThread { speechInputStatus = state } },
        )
        onDeviceSpeechAvailable = onDeviceSpeechInput?.isAvailable() == true
        speechInputStatus = if (onDeviceSpeechAvailable) {
            "On-device speech recognition is available for the current system language."
        } else {
            "On-device speech recognition is unavailable. Type your request instead."
        }

        refreshProfile()
        refreshModelState()
        restoreRemoteSession()
    }

    override fun onResume() {
        super.onResume()
        refreshProfile()
    }

    override fun onDestroy() {
        offlineTts?.close()
        onDeviceSpeechInput?.close()
        offlineTts = null
        onDeviceSpeechInput = null
        remoteEventsJob?.cancel()
        remoteSession?.close()
        remoteSession = null
        super.onDestroy()
    }

    private fun restoreRemoteSession() {
        lifecycleScope.launch {
            try {
                val saved = pairingRepository.remoteV2Pairing.first() ?: return@launch
                val configuration = RemoteV2PairingConfiguration(
                    wsUrl = saved.wsUrl,
                    pcKeyId = saved.pcKeyId,
                    pcPublicKeySpki = saved.pcPublicKeySpki,
                    pcName = saved.pcName,
                    pairingId = "",
                    code = "",
                    expiresAt = Long.MAX_VALUE,
                )
                remoteBusy = true
                remoteStatus = "Reconnecting to ${saved.pcName}…"
                val session = withContext(Dispatchers.IO) { newRemoteClient().reconnect(configuration) }
                attachRemoteSession(session)
                remoteStatus = "Connected to ${saved.pcName} over authenticated v2."
            } catch (error: Exception) {
                remoteStatus = "PC offline or unreachable: ${error.message ?: "reconnect failed"}. Local phone tools remain available."
            } finally {
                remoteBusy = false
            }
        }
    }

    private fun scanRemotePairingQr() {
        val options = GmsBarcodeScannerOptions.Builder()
            .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
            .build()
        GmsBarcodeScanning.getClient(this, options)
            .startScan()
            .addOnSuccessListener { barcode ->
                val raw = barcode.rawValue
                if (raw.isNullOrBlank()) {
                    remoteStatus = "The scanned QR code did not contain a Vanessa pairing payload."
                } else {
                    remoteQrJson = raw
                    pairRemote(raw)
                }
            }
            .addOnCanceledListener {
                remoteStatus = "QR scan cancelled."
            }
            .addOnFailureListener { error ->
                remoteStatus = "QR scanner unavailable: ${error.message ?: "unknown error"}"
            }
    }

    private fun pairRemote(rawQrPayload: String) {
        if (remoteBusy) return
        when (val parsed = RemoteV2PairingPayloadParser.parse(rawQrPayload)) {
            is RemoteV2PairingPayloadResult.Invalid -> {
                remoteStatus = parsed.reason
                return
            }
            is RemoteV2PairingPayloadResult.Valid -> {
                remoteBusy = true
                remoteStatus = "Connecting securely. Approve this phone on the Windows PC…"
                lifecycleScope.launch {
                    try {
                        val session = withContext(Dispatchers.IO) { newRemoteClient().pair(parsed.configuration) }
                        pairingRepository.saveRemoteV2Pairing(
                            StoredRemoteV2Pairing(
                                wsUrl = parsed.configuration.wsUrl,
                                pcKeyId = parsed.configuration.pcKeyId,
                                pcPublicKeySpki = parsed.configuration.pcPublicKeySpki,
                                pcName = parsed.configuration.pcName,
                                deviceId = session.deviceId,
                                grantedScopesJson = session.grantedScopesJson,
                            ),
                        )
                        attachRemoteSession(session)
                        remoteQrJson = ""
                        remoteStatus = "Paired and connected to ${parsed.configuration.pcName}."
                    } catch (error: Exception) {
                        remoteStatus = "Pairing failed: ${error.message ?: "unknown error"}"
                    } finally {
                        remoteBusy = false
                    }
                }
            }
        }
    }

    private fun attachRemoteSession(session: RemoteV2LiveSession) {
        remoteEventsJob?.cancel()
        remoteSession?.takeIf { it !== session }?.close()
        remoteSession = session
        remoteEventsJob = lifecycleScope.launch {
            session.events.collect { envelope ->
                val payload = envelope.payload
                when (envelope.type) {
                    "task.accepted" -> {
                        val taskId = payload["taskId"]?.jsonPrimitive?.content.orEmpty()
                        remoteTaskStatus = if (taskId.isNotBlank()) "Accepted by Windows PC. Task: $taskId" else "Task accepted by Windows PC."
                    }
                    "task.progress" -> {
                        remoteTaskStatus = payload["safeSummary"]?.jsonPrimitive?.content
                            ?: payload["state"]?.jsonPrimitive?.content
                            ?: "Windows PC is working…"
                    }
                    "task.confirmation_required" -> {
                        remotePendingApproval = payload["approval"] as? JsonObject
                        remoteTaskStatus = "Windows PC requires biometric approval for this action."
                    }
                    "task.result" -> {
                        remotePendingApproval = null
                        remoteTaskStatus = payload["safeSummary"]?.jsonPrimitive?.content
                            ?: "The Windows PC returned a task result."
                    }
                    "protocol.error", "task.error" -> {
                        remotePendingApproval = null
                        remoteTaskStatus = payload["message"]?.jsonPrimitive?.content
                            ?: payload["code"]?.jsonPrimitive?.content
                            ?: "The PC rejected the remote request."
                    }
                    "session.close" -> {
                        remoteStatus = "Remote session closed. Reconnect when the PC is available."
                        remoteSession = null
                    }
                }
            }
        }
    }

    private fun openRemoteUrl() {
        val url = remoteOpenUrl.trim()
        if (url.isEmpty()) {
            remoteTaskStatus = "Enter a URL first."
            return
        }
        val session = remoteSession
        if (session == null) {
            remoteTaskStatus = "Connect to a paired Windows PC first."
            return
        }
        remoteTaskStatus = "Submitting open URL request to the PC…"
        lifecycleScope.launch {
            try {
                val requestId = session.submitTask(
                    capability = "open_url",
                    arguments = buildJsonObject { put("url", url) },
                    intent = "Open this URL on the paired Windows PC",
                )
                remoteTaskStatus = "Request sent to PC. Request ID: $requestId"
            } catch (error: Exception) {
                remoteTaskStatus = "Could not submit task: ${error.message ?: "unknown error"}"
            }
        }
    }

    private fun approveRemoteAction() {
        val approval = remotePendingApproval ?: return
        val session = remoteSession ?: run {
            remoteTaskStatus = "Remote session is not active."
            return
        }
        val approvalId = approval["approvalId"]?.jsonPrimitive?.content ?: return
        val taskId = approval["taskId"]?.jsonPrimitive?.content ?: return
        val actionHash = approval["actionHash"]?.jsonPrimitive?.content ?: return
        lifecycleScope.launch {
            try {
                remoteTaskStatus = "Waiting for Android strong biometric authentication…"
                val proof = AndroidBiometricApprovalKeyStore().signApproval(
                    activity = this@MainActivity,
                    taskId = taskId,
                    approvalId = approvalId,
                    actionHash = actionHash,
                )
                val response = buildJsonObject {
                    put("approvalId", approvalId)
                    put("taskId", taskId)
                    put("actionHash", actionHash)
                    put("decision", "approved")
                    put("approvedAt", proof.signedAt)
                    put("method", "biometric_strong")
                    put("approvalProof", buildJsonObject {
                        put("keyId", proof.keyId)
                        put("signature", proof.signature)
                        put("signedAt", proof.signedAt)
                    })
                }
                session.sendApprovalResponse(response)
                remotePendingApproval = null
                remoteTaskStatus = "Biometric proof sent. The PC will verify the action binding before execution."
            } catch (error: Exception) {
                remoteTaskStatus = "Approval was not sent: ${error.message ?: "biometric verification failed"}"
            }
        }
    }

    private fun denyRemoteAction() {
        val approval = remotePendingApproval ?: return
        val session = remoteSession ?: return
        val approvalId = approval["approvalId"]?.jsonPrimitive?.content ?: return
        val taskId = approval["taskId"]?.jsonPrimitive?.content ?: return
        val actionHash = approval["actionHash"]?.jsonPrimitive?.content ?: return
        lifecycleScope.launch {
            try {
                session.sendApprovalResponse(buildJsonObject {
                    put("approvalId", approvalId)
                    put("taskId", taskId)
                    put("actionHash", actionHash)
                    put("decision", "denied")
                    put("approvedAt", System.currentTimeMillis())
                    put("method", "user_denied")
                })
                remotePendingApproval = null
                remoteTaskStatus = "Action denied. The PC task engine received the denial."
            } catch (error: Exception) {
                remoteTaskStatus = "Could not send denial: ${error.message ?: "unknown error"}"
            }
        }
    }

    private fun requestSpeechInput() {
        if (!onDeviceSpeechAvailable) {
            speechInputStatus = "No on-device recognizer is available. Type your request instead."
            return
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
        ) {
            startSpeechInput()
        } else {
            requestMicrophone.launch(Manifest.permission.RECORD_AUDIO)
        }
    }

    private fun startSpeechInput() {
        if (onDeviceSpeechInput?.start() != true) {
            speechInputStatus = "Could not start on-device speech recognition."
        }
    }

    private fun speakAssistantResponse() {
        val text = assistantResponse
        if (text.isBlank() || offlineTts?.speak(text) != true) {
            speechStatus = "An offline TTS voice is not ready. The text response is still available."
        }
    }

    private fun localInference(): LlamaCppInference =
        inference ?: LlamaCppInference.getInstance(applicationContext).also { inference = it }

    private fun refreshProfile() {
        lifecycleScope.launch {
            val state = withContext(Dispatchers.IO) {
                val engine = localInference()
                val snapshot = profiler.snapshot().copy(
                    inferenceRuntimeInstalled = engine.isAvailable,
                    modelLoadVerified = engine.isModelLoaded,
                )
                snapshot to engine.isModelLoaded
            }
            profile = state.first
            inferenceAvailable = state.first.inferenceRuntimeInstalled
            modelLoaded = state.second
        }
    }

    private fun refreshModelState() {
        lifecycleScope.launch {
            modelStatus = "Verifying installed GGUF…"
            val result = withContext(Dispatchers.IO) {
                modelManager.installedModel() to localInference().isAvailable
            }
            installedModel = result.first
            inferenceAvailable = result.second
            modelStatus = when {
                result.first == null -> "No model imported. Select a Qwen3 GGUF to continue."
                !result.second -> "Model imported and checksum verified. Native inference is unavailable on this device."
                else -> "Model imported and checksum verified. Load it to start the local agent."
            }
            refreshProfile()
        }
    }

    private fun chooseModel() {
        if (modelLoaded || modelBusy) {
            modelStatus = "Unload the current model before importing another."
            return
        }
        openModel.launch(arrayOf("*/*"))
    }

    private fun importModel(uri: Uri) {
        if (modelLoaded || modelBusy) return
        modelBusy = true
        modelStatus = "Importing and verifying model. This may take several minutes…"
        lifecycleScope.launch {
            try {
                when (val result = withContext(Dispatchers.IO) { modelManager.importModel(uri) }) {
                    is ModelImportResult.Success -> {
                        installedModel = result.model
                        modelStatus = if (result.alreadyInstalled) {
                            "This model is already installed and verified."
                        } else {
                            "Model imported and SHA-256 verified."
                        }
                    }
                    is ModelImportResult.Failure -> modelStatus = "Model import failed: ${result.reason}"
                    ModelImportResult.Cancelled -> modelStatus = "Model import cancelled."
                }
                refreshProfile()
            } catch (error: Exception) {
                modelStatus = "Model import failed: ${error.message ?: "unknown error"}"
            } finally {
                modelBusy = false
            }
        }
    }

    private fun loadModel() {
        if (modelBusy || modelLoaded) return
        modelBusy = true
        modelStatus = "Loading Qwen3 into local memory…"
        lifecycleScope.launch {
            try {
                val model = withContext(Dispatchers.IO) { modelManager.installedModel() }
                    ?: throw IllegalStateException("No valid GGUF model is installed")
                val engine = localInference()
                if (!engine.isAvailable) {
                    throw IllegalStateException("Local inference requires a supported arm64-v8a device running Android API 28 or newer")
                }
                withContext(Dispatchers.IO) { engine.loadModel(File(model.path)) }
                installedModel = model
                modelLoaded = true
                modelStatus = "Qwen3 is loaded. Vanessa can now plan and run approved local tools."
                refreshProfile()
            } catch (error: Exception) {
                modelLoaded = false
                modelStatus = "Model load failed: ${error.message ?: "unknown error"}"
                refreshProfile()
            } finally {
                modelBusy = false
            }
        }
    }

    private fun unloadModel() {
        if (modelBusy || !modelLoaded) return
        modelBusy = true
        modelStatus = "Releasing local model memory…"
        lifecycleScope.launch {
            try {
                withContext(Dispatchers.IO) { inference?.close() }
                inference = null
                modelLoaded = false
                modelStatus = "Model unloaded. The GGUF remains installed."
                assistantMetrics = ""
                refreshProfile()
            } catch (error: Exception) {
                modelStatus = "Model unload failed: ${error.message ?: "unknown error"}"
            } finally {
                modelBusy = false
            }
        }
    }

    private fun runAssistant(request: String) {
        val task = request.trim()
        if (task.isEmpty()) {
            assistantResponse = "Enter a request first."
            return
        }
        if (!modelLoaded) {
            assistantResponse = "Import and load the local Qwen3 model before asking Vanessa to run a task."
            return
        }
        if (assistantBusy) return

        assistantBusy = true
        assistantResponse = "Planning locally with Qwen3…"
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
                            assistantMetrics = "Last generation: ${it.ttftMs} ms TTFT · " +
                                "${"%.1f".format(java.util.Locale.ROOT, it.tokensPerSecond)} tokens/s"
                        }
                    }
                    is LocalPlanOutcome.Failure -> {
                        if (outcome.error == LocalPlanError.PERMISSION_REQUIRED &&
                            !hasCalendarPermission()
                        ) {
                            pendingAgentPrompt = task
                            assistantResponse = "Vanessa needs calendar access for this request. Android will ask for permission."
                            awaitingPermission = true
                            requestCalendar.launch(Manifest.permission.READ_CALENDAR)
                        } else {
                            assistantResponse = outcome.reason
                        }
                    }
                }
            } catch (error: Exception) {
                assistantResponse = "Local task failed: ${error.message ?: "unknown error"}"
            } finally {
                if (!awaitingPermission) assistantBusy = false
            }
        }
    }

    private fun hasCalendarPermission(): Boolean = ContextCompat.checkSelfPermission(
        this, Manifest.permission.READ_CALENDAR
    ) == PackageManager.PERMISSION_GRANTED

    private fun requestMeetings() {
        if (hasCalendarPermission()) searchCalendar()
        else requestCalendar.launch(Manifest.permission.READ_CALENDAR)
    }

    private fun searchCalendar() {
        calendarJob?.cancel()
        meetings = emptyList()
        calendarMessage = "Searching phone calendar…"
        calendarJob = lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) { calendarTool.today() }
            if (!hasCalendarPermission()) {
                meetings = emptyList()
                calendarMessage = "Calendar permission was removed. No events are shown."
            } else when (result) {
                is CalendarSearchResult.Success -> {
                    meetings = result.meetings
                    calendarMessage = if (meetings.isEmpty()) "No events in the phone calendars today." else
                        "${meetings.size} event(s) from phone calendars today."
                }
                CalendarSearchResult.PermissionRequired -> calendarMessage = "Calendar permission required."
                is CalendarSearchResult.Unavailable -> calendarMessage = result.reason
            }
        }
    }
}

@Composable
private fun DeviceScreen(
    profile: DeviceProfile?,
    installedModel: InstalledModel?,
    modelStatus: String,
    inferenceAvailable: Boolean,
    modelLoaded: Boolean,
    modelBusy: Boolean,
    prompt: String,
    assistantResponse: String,
    assistantMetrics: String,
    assistantBusy: Boolean,
    speechReady: Boolean,
    speechStatus: String,
    speechInputStatus: String,
    onDeviceSpeechAvailable: Boolean,
    meetings: List<CalendarMeeting>,
    calendarMessage: String?,
    remoteQrJson: String,
    remoteStatus: String,
    remoteBusy: Boolean,
    remoteOpenUrl: String,
    remoteTaskStatus: String,
    remotePendingApproval: JsonObject?,
    onRemoteQrChange: (String) -> Unit,
    onPairRemote: (String) -> Unit,
    onScanRemoteQr: () -> Unit,
    onReconnectRemote: () -> Unit,
    onRemoteUrlChange: (String) -> Unit,
    onOpenRemoteUrl: () -> Unit,
    onApproveRemote: () -> Unit,
    onDenyRemote: () -> Unit,
    onRefresh: () -> Unit,
    onImportModel: () -> Unit,
    onLoadModel: () -> Unit,
    onUnloadModel: () -> Unit,
    onPromptChange: (String) -> Unit,
    onRunAssistant: () -> Unit,
    onSpeakRequest: () -> Unit,
    onSpeakResponse: () -> Unit,
    onReadCalendar: () -> Unit,
) {
    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text("VANESSA", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
            Text("Your local AI agent", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.SemiBold)
            Text(
                "Private on-device reasoning and Android tools, with an authenticated remote Windows PC connection.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        Card(modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("DEVICE PROFILE", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
                if (profile == null) {
                    Text("Measuring device capabilities…")
                } else {
                    Text(
                        if (profile.operatingMode == OperatingMode.LOCAL_AGENT) "Local agent capable"
                        else "Compatibility mode",
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Text("${profile.manufacturer} ${profile.model} · Android API ${profile.apiLevel}")
                    Text("CPU: ${profile.abi} · RAM: ${profile.ramAvailableMb} MB available / ${profile.ramTotalMb} MB")
                    Text("Storage: ${profile.storageAvailableMb} MB · Battery: ${profile.batteryPercent?.let { "${it}%" } ?: "unknown"}")
                    Text("Thermal: ${profile.thermalStatus ?: "unknown"} · Power saver: ${if (profile.powerSaveMode) "on" else "off"}")
                    Text("Calendar permission: ${if (profile.calendarReadGranted) "granted" else "not granted"}")
                    Text("Native runtime: ${if (profile.inferenceRuntimeInstalled) "available" else "unavailable"} · Model loaded: ${if (profile.modelLoadVerified) "yes" else "no"}")
                }
                TextButton(onClick = onRefresh) { Text("Refresh device profile") }
            }
        }

        Card(modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
                Text("LOCAL MODEL", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
                Text(
                    installedModel?.let { "Qwen3 GGUF · ${formatBytes(it.bytes)} · SHA-256 ${it.sha256.take(16)}…" }
                        ?: "No verified model installed",
                    style = MaterialTheme.typography.bodyMedium,
                )
                Text(modelStatus, style = MaterialTheme.typography.bodySmall)
                Text(
                    if (inferenceAvailable) "llama.cpp runtime is available on this device."
                    else "Local inference needs arm64-v8a and Android API 28+ in this build.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (modelBusy) LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = onImportModel, enabled = !modelBusy && !modelLoaded) { Text("Import GGUF") }
                    Button(onClick = onLoadModel, enabled = !modelBusy && !modelLoaded && installedModel != null && inferenceAvailable) {
                        Text("Load model")
                    }
                    TextButton(onClick = onUnloadModel, enabled = !modelBusy && modelLoaded) { Text("Unload") }
                }
            }
        }

        Card(modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("ASK VANESSA", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
                Text("Qwen3 plans against a strict allow-list. Android checks permissions again when each tool executes.")
                OutlinedTextField(
                    value = prompt,
                    onValueChange = onPromptChange,
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("What should I do?") },
                    placeholder = { Text("Check whether I have any meetings today") },
                    minLines = 2,
                    maxLines = 4,
                    enabled = modelLoaded && !assistantBusy,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(
                        onClick = onSpeakRequest,
                        enabled = onDeviceSpeechAvailable && !assistantBusy,
                    ) { Text("Speak request") }
                    TextButton(
                        onClick = onSpeakResponse,
                        enabled = speechReady && assistantResponse.isNotBlank(),
                    ) { Text("Speak response") }
                }
                Text(speechInputStatus, style = MaterialTheme.typography.labelSmall)
                Text(speechStatus, style = MaterialTheme.typography.labelSmall)
                Button(
                    onClick = onRunAssistant,
                    enabled = modelLoaded && !assistantBusy && prompt.isNotBlank(),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    if (assistantBusy) CircularProgressIndicator()
                    else Text("Run local task")
                }
                if (assistantResponse.isNotBlank()) {
                    Text(assistantResponse, style = MaterialTheme.typography.bodyMedium)
                }
                if (assistantMetrics.isNotBlank()) {
                    Text(assistantMetrics, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }

        Card(modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
                Text("REMOTE WINDOWS PC", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
                Text("Pair with the PC over its Tailscale WSS address. Paste the one-time pairing QR payload copied from Vanessa Desktop.")
                OutlinedTextField(
                    value = remoteQrJson,
                    onValueChange = onRemoteQrChange,
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("Pairing QR payload") },
                    placeholder = { Text("Paste the copied pairing payload") },
                    minLines = 2,
                    maxLines = 5,
                    enabled = !remoteBusy,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = onScanRemoteQr, enabled = !remoteBusy, modifier = Modifier.weight(1f)) {
                        Text("Scan QR")
                    }
                    Button(onClick = onReconnectRemote, enabled = !remoteBusy, modifier = Modifier.weight(1f)) {
                        Text("Reconnect")
                    }
                }
                Button(
                    onClick = { onPairRemote(remoteQrJson) },
                    enabled = !remoteBusy && remoteQrJson.isNotBlank(),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    if (remoteBusy) CircularProgressIndicator()
                    else Text("Pair / connect to PC")
                }
                Text(remoteStatus, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                OutlinedTextField(
                    value = remoteOpenUrl,
                    onValueChange = onRemoteUrlChange,
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("URL to open on PC") },
                    singleLine = true,
                )
                Button(
                    onClick = onOpenRemoteUrl,
                    enabled = remoteStatus.contains("connected", ignoreCase = true) && remoteOpenUrl.isNotBlank(),
                    modifier = Modifier.fillMaxWidth(),
                ) { Text("Open URL on Windows PC") }
                if (remoteTaskStatus.isNotBlank()) Text(remoteTaskStatus, style = MaterialTheme.typography.bodySmall)
                remotePendingApproval?.let { approval ->
                    Card(modifier = Modifier.fillMaxWidth()) {
                        Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text("PC ACTION REQUIRES APPROVAL", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.error)
                            Text(approval["consequence"]?.jsonPrimitive?.content ?: "The PC requests approval for a remote action.")
                            Text("Task: " + (approval["taskId"]?.jsonPrimitive?.content ?: "unknown"), style = MaterialTheme.typography.labelSmall)
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Button(onClick = onApproveRemote, enabled = !remoteBusy) { Text("Approve with biometric") }
                                TextButton(onClick = onDenyRemote, enabled = !remoteBusy) { Text("Deny") }
                            }
                        }
                    }
                }
                Text(
                    "Remote commands run on the PC under its local capabilities and policy. The Android identity key authenticates the device; destructive approvals require a separate strong-biometric key.",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        Card(modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("PHONE CALENDAR", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
                Text("Direct read-only calendar check. Events stay on this device.")
                Button(onClick = onReadCalendar) { Text("Check today's meetings") }
                calendarMessage?.let { Text(it) }
                meetings.take(8).forEach { event ->
                    Text(
                        "${DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(event.startsAtMs))} · " +
                            "${event.title} · ${event.calendarName}",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
        }
    }
}

private fun formatBytes(bytes: Long): String = when {
    bytes >= 1024L * 1024 * 1024 -> String.format(java.util.Locale.ROOT, "%.2f GB", bytes / (1024.0 * 1024 * 1024))
    bytes >= 1024L * 1024 -> String.format(java.util.Locale.ROOT, "%.0f MB", bytes / (1024.0 * 1024))
    else -> "${bytes} bytes"
}
