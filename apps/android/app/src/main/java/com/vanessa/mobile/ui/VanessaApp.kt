package com.vanessa.mobile.ui

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ArrowBack
import androidx.compose.material.icons.outlined.BatteryFull
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.Computer
import androidx.compose.material.icons.outlined.Home
import androidx.compose.material.icons.outlined.Memory
import androidx.compose.material.icons.outlined.Menu
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material.icons.outlined.Monitor
import androidx.compose.material.icons.outlined.PhoneAndroid
import androidx.compose.material.icons.outlined.QrCode2
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Send
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.Storage
import androidx.compose.material.icons.outlined.Stop
import androidx.compose.material.icons.outlined.VolumeUp
import androidx.compose.material.icons.outlined.WifiOff
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.vanessa.mobile.ui.components.VanessaOrb
import com.vanessa.mobile.ui.theme.VanessaPalette
import com.vanessa.mobile.model.InstalledModel
import com.vanessa.mobile.profile.DeviceProfile
import java.io.File
import java.util.Locale

@Composable
internal fun VanessaApp(
    startupReady: Boolean,
    startupMessage: String,
    destination: String,
    profile: DeviceProfile?,
    model: InstalledModel?,
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
    voiceListening: Boolean,
    microphonePermissionGranted: Boolean,
    modelImportBusy: Boolean,
    modelImportMessage: String,
    pairingNotice: String?,
    onNavigate: (String) -> Unit,
    onPromptChange: (String) -> Unit,
    onRunAssistant: () -> Unit,
    onSpeakRequest: () -> Unit,
    onStopSpeech: () -> Unit,
    onSpeakResponse: () -> Unit,
    onRefresh: () -> Unit,
    onImportModel: (String) -> Unit,
    onStartPairing: () -> Unit,
    onDismissPairingNotice: () -> Unit,
    approval: ApprovalRequest?,
    execution: ExecutionState?,
    completion: CompletionState,
    onCompleteOnboarding: () -> Unit,
    onRequestPermissions: () -> Unit,
    onApprove: () -> Unit,
    onCancelApproval: () -> Unit,
) {
    BoxWithConstraints(
        modifier = Modifier.fillMaxSize().background(VanessaPalette.Background),
    ) {
        val inset = if (maxWidth < 360.dp) 16.dp else 24.dp

        if (!startupReady) {
            SplashScreen(startupMessage)
        } else {
            Column(
                modifier = Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing),
            ) {
                Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
                    when (destination) {
                        "WELCOME" -> WelcomeScreen(
                            inset = inset,
                            onStart = { onNavigate("ONBOARDING") },
                        )
                        "ONBOARDING" -> OnboardingScreen(
                            inset = inset,
                            onBack = { onNavigate("WELCOME") },
                            onSkip = onCompleteOnboarding,
                            onContinue = { onNavigate("PERMISSIONS") },
                        )
                        "PERMISSIONS" -> PermissionsScreen(
                            inset = inset,
                            microphoneGranted = microphonePermissionGranted,
                            calendarGranted = profile?.calendarReadGranted == true,
                            onBack = { onNavigate("ONBOARDING") },
                            onRequestAll = onRequestPermissions,
                            onFinish = onCompleteOnboarding,
                        )
                        "LISTENING" -> ListeningScreen(
                            inset = inset,
                            listening = voiceListening,
                            speechAvailable = onDeviceSpeechAvailable,
                            status = speechInputStatus,
                            onStop = onStopSpeech,
                            onClose = { onNavigate("HOME") },
                            onTypeInstead = { onNavigate("HOME") },
                        )
                        "CONFIRM" -> ConfirmActionScreen(
                            inset = inset,
                            approval = approval,
                            onApprove = onApprove,
                            onCancel = onCancelApproval,
                        )
                        "EXECUTING" -> ExecutingScreen(
                            inset = inset,
                            execution = execution,
                            onClose = { onNavigate("HOME") },
                        )
                        "SUCCESS" -> SuccessScreen(
                            inset = inset,
                            completion = completion,
                            onDone = { onNavigate("HOME") },
                        )
                        "PAIRING" -> PairingScreen(
                            inset, pairingNotice, onNavigate, onStartPairing, onDismissPairingNotice,
                        )
                        "PC" -> PcDashboardScreen(inset, onNavigate)
                        "SETTINGS" -> SettingsScreen(
                            inset, profile, model, modelStatus, inferenceAvailable, modelLoaded,
                            speechReady, speechStatus, speechInputStatus, onDeviceSpeechAvailable,
                            microphonePermissionGranted, modelImportBusy, modelImportMessage,
                            onNavigate, onRefresh, onImportModel,
                        )
                        else -> ChatScreen(
                            inset = inset,
                            modelLoaded = modelLoaded,
                            modelBusy = modelBusy,
                            assistantBusy = assistantBusy,
                            prompt = prompt,
                            response = assistantResponse,
                            metrics = assistantMetrics,
                            speechReady = speechReady,
                            onPromptChange = onPromptChange,
                            onSend = onRunAssistant,
                            onListen = onSpeakRequest,
                            onSpeakResponse = onSpeakResponse,
                            onNavigate = onNavigate,
                        )
                    }
                }
                // Settings is a first-class destination, so the shell (not an
                // individual screen) owns the persistent navigation bar. Before
                // this, BottomNavigation was never composed and the only way to
                // Settings was the small icon on Home.
                if (destination == "HOME" || destination == "PC" || destination == "SETTINGS") {
                    BottomNavigation(destination, onNavigate)
                }
            }
        }
    }
}

@Composable
private fun SplashScreen(message: String) {
    Box(
        modifier = Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing).background(
            Brush.radialGradient(
                colors = listOf(Color(0xFF111C33), VanessaPalette.Background, VanessaPalette.Background),
                radius = 850f,
            ),
        ),
        contentAlignment = Alignment.Center,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(18.dp)) {
            VanessaOrb(size = 116.dp, energy = 0f, offline = false, description = "Vanessa orb. Starting up.")
            Text("VANESSA", color = VanessaPalette.TextPrimary, style = MaterialTheme.typography.headlineMedium, letterSpacing = 4.sp)
            Text("Local assistant", color = VanessaPalette.TextSecondary, style = MaterialTheme.typography.bodyMedium)
            Spacer(Modifier.height(8.dp))
            Text(message, color = VanessaPalette.TextSecondary, style = MaterialTheme.typography.labelSmall)
        }
    }
}

@Composable
private fun PairingScreen(
    inset: Dp,
    pairingNotice: String?,
    onNavigate: (String) -> Unit,
    onStartPairing: () -> Unit,
    onDismissPairingNotice: () -> Unit,
) {
    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())
            .padding(horizontal = inset).padding(top = 16.dp, bottom = 28.dp),
        verticalArrangement = Arrangement.spacedBy(22.dp),
    ) {
        ScreenHeader("Pair with Windows", "YOUR DEVICES") { onNavigate("PC") }
        Text("Bring your PC into Vanessa.", color = VanessaPalette.TextPrimary, style = MaterialTheme.typography.headlineMedium)
        Text(
            "Pairing uses an authenticated connection initiated by the Windows companion. Scanning a code alone does not establish trust.",
            color = VanessaPalette.TextSecondary, style = MaterialTheme.typography.bodyMedium,
        )
        Surface(
            modifier = Modifier.fillMaxWidth(), color = VanessaPalette.Surface,
            shape = RoundedCornerShape(20.dp),
            border = androidx.compose.foundation.BorderStroke(1.dp, VanessaPalette.Border),
        ) {
            Column(
                modifier = Modifier.padding(vertical = 24.dp, horizontal = 20.dp),
                horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                Box(
                    modifier = Modifier.size(184.dp).border(1.dp, VanessaPalette.Border, RoundedCornerShape(22.dp))
                        .background(VanessaPalette.SurfaceStrong, RoundedCornerShape(22.dp)),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Icons.Outlined.QrCode2, contentDescription = "Pairing QR code placeholder", tint = VanessaPalette.TextSecondary, modifier = Modifier.size(82.dp))
                }
                Text("Windows companion", color = VanessaPalette.TextPrimary, style = MaterialTheme.typography.titleLarge)
                Text(
                    "Open Vanessa on your PC and display its one-time pairing code.",
                    color = VanessaPalette.TextSecondary, style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.Center,
                )
                Button(
                    onClick = onStartPairing, modifier = Modifier.fillMaxWidth().height(52.dp),
                    shape = RoundedCornerShape(14.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = VanessaPalette.SurfaceStrong, contentColor = VanessaPalette.TextPrimary),
                ) {
                    Icon(Icons.Outlined.Lock, contentDescription = null)
                    Spacer(Modifier.width(8.dp))
                    Text("Scan PC pairing code")
                }
                Text(
                    "The remote control screen verifies the PC identity and completes authenticated v2 pairing. New phones require local approval on the PC.",
                    color = VanessaPalette.Warning, style = MaterialTheme.typography.labelSmall, textAlign = TextAlign.Center,
                )
            }
        }
        if (pairingNotice != null) InlineNotice(pairingNotice, NoticeTone.WARNING, onDismissPairingNotice)
        Surface(modifier = Modifier.fillMaxWidth(), color = VanessaPalette.SurfaceStrong, shape = RoundedCornerShape(16.dp)) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Before you connect", color = VanessaPalette.TextPrimary, style = MaterialTheme.typography.titleLarge)
                Text("• Keep Vanessa open on the Windows PC.", color = VanessaPalette.TextSecondary, style = MaterialTheme.typography.bodyMedium)
                Text("• Confirm the PC identity before trusting it.", color = VanessaPalette.TextSecondary, style = MaterialTheme.typography.bodyMedium)
                Text("• Paired and connected are different states.", color = VanessaPalette.TextSecondary, style = MaterialTheme.typography.bodyMedium)
            }
        }
    }
}

@Composable
private fun PcDashboardScreen(
    inset: Dp,
    onNavigate: (String) -> Unit,
) {
    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())
            .padding(horizontal = inset).padding(top = 18.dp, bottom = 28.dp),
        verticalArrangement = Arrangement.spacedBy(22.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { onNavigate("HOME") }, modifier = Modifier.size(48.dp)) {
                Icon(Icons.Outlined.ArrowBack, contentDescription = "Back to assistant home", tint = VanessaPalette.TextPrimary)
            }
            Column(modifier = Modifier.weight(1f)) {
                Text("MY PC", color = VanessaPalette.TextSecondary, style = MaterialTheme.typography.labelSmall, letterSpacing = 1.4.sp)
                Text("Windows companion", color = VanessaPalette.TextPrimary, style = MaterialTheme.typography.headlineMedium)
            }
            StatusPill("PC CONTROL", VanessaPalette.TextSecondary)
        }
        Surface(
            modifier = Modifier.fillMaxWidth(), color = VanessaPalette.Surface,
            shape = RoundedCornerShape(20.dp),
            border = androidx.compose.foundation.BorderStroke(1.dp, VanessaPalette.Border),
        ) {
            Column(
                modifier = Modifier.padding(22.dp), horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                Box(
                    modifier = Modifier.size(92.dp).clip(CircleShape).background(VanessaPalette.SurfaceStrong),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Icons.Outlined.Computer, contentDescription = null, tint = VanessaPalette.TextSecondary, modifier = Modifier.size(42.dp))
                }
                Text("Windows companion", color = VanessaPalette.TextPrimary, style = MaterialTheme.typography.titleLarge)
                Text(
                    "Open remote control to pair a Windows companion or resume a saved connection. Live state is shown in the remote control screen.",
                    color = VanessaPalette.TextSecondary, style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.Center,
                )
                PrimaryAction(
                    "Pair with Windows",
                    icon = { Icon(Icons.Outlined.QrCode2, contentDescription = null) },
                    onClick = { onNavigate("PAIRING") },
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
        SectionHeading("DEVICE STATUS", "No live telemetry")
        Surface(
            modifier = Modifier.fillMaxWidth(), color = VanessaPalette.Surface,
            shape = RoundedCornerShape(18.dp),
            border = androidx.compose.foundation.BorderStroke(1.dp, VanessaPalette.Border),
        ) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                DeviceMetricRow(Icons.Outlined.Memory, "Processor", "Open remote control to inspect")
                ThinDivider()
                DeviceMetricRow(Icons.Outlined.Storage, "Memory", "Unavailable until connected")
                ThinDivider()
                DeviceMetricRow(Icons.Outlined.WifiOff, "Network", "Not checked in this dashboard")
            }
        }
        InlineNotice(
            "Connection state and verified task results are shown in the remote control screen; this dashboard does not infer a live PC session.",
            NoticeTone.INFO,
        )
    }
}

@Composable
private fun SettingsScreen(
    inset: Dp,
    profile: DeviceProfile?,
    model: InstalledModel?,
    modelStatus: String,
    inferenceAvailable: Boolean,
    modelLoaded: Boolean,
    speechReady: Boolean,
    speechStatus: String,
    speechInputStatus: String,
    onDeviceSpeechAvailable: Boolean,
    microphonePermissionGranted: Boolean,
    modelImportBusy: Boolean,
    modelImportMessage: String,
    onNavigate: (String) -> Unit,
    onRefresh: () -> Unit,
    onImportModel: (String) -> Unit,
) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val versionName = runCatching {
        context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "0.1.0"
    }.getOrDefault("0.1.0")
    var expectedModelSha256 by remember { mutableStateOf("") }

    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())
            .padding(horizontal = inset).padding(top = 18.dp, bottom = 30.dp),
        verticalArrangement = Arrangement.spacedBy(22.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { onNavigate("HOME") }, modifier = Modifier.size(48.dp)) {
                Icon(Icons.Outlined.ArrowBack, contentDescription = "Back to assistant home", tint = VanessaPalette.TextPrimary)
            }
            Column(modifier = Modifier.weight(1f)) {
                Text("PREFERENCES", color = VanessaPalette.TextSecondary, style = MaterialTheme.typography.labelSmall, letterSpacing = 1.4.sp)
                Text("Settings", color = VanessaPalette.TextPrimary, style = MaterialTheme.typography.headlineMedium)
            }
            IconButton(onClick = onRefresh) {
                Icon(Icons.Outlined.Refresh, contentDescription = "Refresh device information", tint = VanessaPalette.TextSecondary)
            }
        }

        SettingsSection("LOCAL MODEL") {
            SettingsValue(
                "Installed model", model?.let { File(it.path).name } ?: "Not detected",
                if (modelLoaded) "Active" else if (model != null) "Detected" else "Unavailable",
                if (modelLoaded) VanessaPalette.Success else VanessaPalette.Warning,
            )
            SettingsValue("Model size", model?.let { formatBytes(it.bytes) } ?: "—")
            SettingsValue("SHA-256", model?.let { it.sha256.take(20) + "…" } ?: "—")
            SettingsValue("Native runtime", if (inferenceAvailable) "Available" else "Unavailable")
            Text(modelStatus, color = VanessaPalette.TextSecondary, style = MaterialTheme.typography.bodyMedium)
            Text(
                "The installed model is detected and loaded automatically when the device has sufficient memory. Model weights are not bundled in the APK.",
                color = VanessaPalette.TextSecondary, style = MaterialTheme.typography.labelSmall,
            )
            OutlinedTextField(
                value = expectedModelSha256,
                onValueChange = { if (it.length <= 64) expectedModelSha256 = it },
                modifier = Modifier.fillMaxWidth(),
                label = { Text("Expected SHA-256 (optional)") },
                placeholder = { Text("64-character checksum") },
                singleLine = true,
                enabled = !modelImportBusy,
                shape = RoundedCornerShape(12.dp),
            )
            Button(
                onClick = { onImportModel(expectedModelSha256.trim()) },
                enabled = !modelImportBusy,
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(14.dp),
                colors = ButtonDefaults.buttonColors(containerColor = VanessaPalette.Brand),
            ) {
                Text(if (modelImportBusy) "Importing model…" else "Import GGUF")
            }
            Text(
                "Choose a .gguf file. Vanessa copies it to app-private storage, validates its GGUF header, computes SHA-256, and checks the optional expected checksum.",
                color = VanessaPalette.TextSecondary, style = MaterialTheme.typography.labelSmall,
            )
            Text(
                modelImportMessage,
                color = if (modelImportMessage.startsWith("Import failed") || modelImportMessage.contains("failed", ignoreCase = true))
                    VanessaPalette.Error else VanessaPalette.TextSecondary,
                style = MaterialTheme.typography.labelSmall,
            )
        }

        SettingsSection("VOICE") {
            SettingsValue(
                "On-device speech recognition",
                if (onDeviceSpeechAvailable) "Available" else "Unavailable",
                if (onDeviceSpeechAvailable) "Ready" else "Unavailable",
                if (onDeviceSpeechAvailable) VanessaPalette.Success else VanessaPalette.Warning,
            )
            SettingsValue("Microphone permission", if (microphonePermissionGranted) "Granted" else "Not granted")
            SettingsValue("Offline speech output", if (speechReady) "Available" else "Unavailable")
            Text(speechInputStatus, color = VanessaPalette.TextSecondary, style = MaterialTheme.typography.labelSmall)
            Text(speechStatus, color = VanessaPalette.TextSecondary, style = MaterialTheme.typography.labelSmall)
        }

        SettingsSection("THIS DEVICE") {
            SettingsValue("Device", profile?.let { "${it.manufacturer} ${it.model}" } ?: "Checking…")
            SettingsValue("Android version", profile?.let { "API ${it.apiLevel}" } ?: "—")
            SettingsValue("Architecture", profile?.abi ?: "—")
            SettingsValue("Available memory", profile?.let { "${it.ramAvailableMb} MB of ${it.ramTotalMb} MB" } ?: "—")
            SettingsValue("Available storage", profile?.let { "${it.storageAvailableMb} MB" } ?: "—")
            SettingsValue("Battery", profile?.batteryPercent?.let { "$it%" } ?: "Unknown")
            SettingsValue("Calendar permission", if (profile?.calendarReadGranted == true) "Granted" else "Not granted")
        }

        SettingsSection("WINDOWS CONNECTION") {
            SettingsValue("Connection management", "Available from My PC")
            Text(
                "Pair or reconnect from My PC to use the authenticated Windows connection. New phones require approval on the Windows PC.",
                color = VanessaPalette.TextSecondary, style = MaterialTheme.typography.bodyMedium,
            )
            TextButton(onClick = { onNavigate("PC") }) {
                Text("Manage Windows connection")
                Spacer(Modifier.width(6.dp))
                Icon(Icons.Outlined.ChevronRight, contentDescription = null)
            }
        }

        SettingsSection("ABOUT") {
            SettingsValue("Vanessa Android", versionName)
            SettingsValue("Minimum Android", "API 26+")
            SettingsValue("Build type", "Development prototype")
        }
    }
}

@Composable
private fun ScreenHeader(title: String, eyebrow: String, onBack: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        IconButton(onClick = onBack) {
            Icon(Icons.Outlined.ArrowBack, contentDescription = "Back", tint = VanessaPalette.TextPrimary)
        }
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(eyebrow, color = VanessaPalette.TextSecondary, style = MaterialTheme.typography.labelSmall, letterSpacing = 1.3.sp)
            Text(title, color = VanessaPalette.TextPrimary, style = MaterialTheme.typography.titleLarge)
        }
    }
}

@Composable
private fun BottomNavigation(destination: String, onNavigate: (String) -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().background(VanessaPalette.Background)
            .border(1.dp, VanessaPalette.Border).padding(horizontal = 18.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.SpaceAround, verticalAlignment = Alignment.CenterVertically,
    ) {
        NavigationItem("HOME", "Home", Icons.Outlined.Home, destination == "HOME", onNavigate)
        NavigationItem("PC", "My PC", Icons.Outlined.Computer, destination == "PC" || destination == "PAIRING", onNavigate)
        NavigationItem("SETTINGS", "Settings", Icons.Outlined.Settings, destination == "SETTINGS", onNavigate)
    }
}

@Composable
private fun NavigationItem(
    route: String,
    label: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    selected: Boolean,
    onNavigate: (String) -> Unit,
) {
    Column(
        modifier = Modifier.clip(RoundedCornerShape(12.dp)).clickable { onNavigate(route) }
            .padding(horizontal = 18.dp, vertical = 5.dp)
            .semantics { contentDescription = "$label navigation" },
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        // The descriptor only belongs to the icon; the visible label is a
        // separate node so TalkBack announces both and UI tests can either
        // target the labelled tab or match the visible text.
        Icon(icon, contentDescription = null, tint = if (selected) VanessaPalette.Brand else VanessaPalette.TextSecondary, modifier = Modifier.size(22.dp))
        Text(label, color = if (selected) VanessaPalette.TextPrimary else VanessaPalette.TextSecondary, style = MaterialTheme.typography.labelSmall)
    }
}

@Composable
private fun StatusPill(text: String, color: Color) {
    Surface(
        color = color.copy(alpha = 0.10f), shape = CircleShape,
        border = androidx.compose.foundation.BorderStroke(1.dp, color.copy(alpha = 0.25f)),
    ) {
        Text(text, modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp), color = color, style = MaterialTheme.typography.labelSmall, maxLines = 1)
    }
}

@Composable
private fun PrimaryAction(
    text: String,
    icon: @Composable (() -> Unit)? = null,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Button(
        onClick = onClick, modifier = modifier.height(54.dp), shape = RoundedCornerShape(14.dp),
        colors = ButtonDefaults.buttonColors(containerColor = VanessaPalette.Brand, contentColor = Color.White),
    ) {
        if (icon != null) {
            icon()
            Spacer(Modifier.width(8.dp))
        }
        Text(text, style = MaterialTheme.typography.labelLarge)
    }
}

@Composable
private fun SectionHeading(title: String, trailing: String? = null) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(title, modifier = Modifier.weight(1f), color = VanessaPalette.TextSecondary, style = MaterialTheme.typography.labelLarge, letterSpacing = 1.2.sp)
        if (trailing != null) Text(trailing, color = VanessaPalette.TextSecondary, style = MaterialTheme.typography.labelSmall)
    }
}

@Composable
private fun DeviceRow(
    icon: @Composable () -> Unit,
    title: String,
    subtitle: String,
    status: String,
    statusColor: Color,
    onClick: (() -> Unit)? = null,
) {
    Row(
        modifier = Modifier.fillMaxWidth().then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier).padding(vertical = 13.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier.size(42.dp).clip(RoundedCornerShape(12.dp)).background(VanessaPalette.SurfaceStrong),
            contentAlignment = Alignment.Center,
        ) {
            androidx.compose.runtime.CompositionLocalProvider(
                androidx.compose.material3.LocalContentColor provides VanessaPalette.TextSecondary,
            ) { icon() }
        }
        Spacer(Modifier.width(12.dp))
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, color = VanessaPalette.TextPrimary, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(subtitle, color = VanessaPalette.TextSecondary, style = MaterialTheme.typography.labelSmall)
        }
        Text(status, color = statusColor, style = MaterialTheme.typography.labelSmall)
    }
}

@Composable
private fun DeviceMetricRow(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    title: String,
    value: String,
) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, contentDescription = null, tint = VanessaPalette.TextSecondary, modifier = Modifier.size(20.dp))
        Spacer(Modifier.width(12.dp))
        Text(title, modifier = Modifier.weight(1f), color = VanessaPalette.TextPrimary, style = MaterialTheme.typography.bodyMedium)
        Text(value, color = VanessaPalette.TextSecondary, style = MaterialTheme.typography.labelSmall, textAlign = TextAlign.End)
    }
}

@Composable
private fun ThinDivider() {
    Box(Modifier.fillMaxWidth().height(1.dp).background(VanessaPalette.Border))
}

internal enum class NoticeTone { INFO, WARNING }

@Composable
internal fun InlineNotice(text: String, tone: NoticeTone, onDismiss: (() -> Unit)? = null) {
    val color = if (tone == NoticeTone.WARNING) VanessaPalette.Warning else VanessaPalette.TextSecondary
    Surface(
        modifier = Modifier.fillMaxWidth(), color = color.copy(alpha = 0.08f),
        shape = RoundedCornerShape(14.dp),
        border = androidx.compose.foundation.BorderStroke(1.dp, color.copy(alpha = 0.22f)),
    ) {
        Row(modifier = Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(text, modifier = Modifier.weight(1f), color = VanessaPalette.TextPrimary, style = MaterialTheme.typography.bodyMedium)
            if (onDismiss != null) TextButton(onClick = onDismiss) { Text("Dismiss", color = color) }
        }
    }
}

@Composable
private fun SettingsSection(title: String, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        SectionHeading(title)
        Surface(
            modifier = Modifier.fillMaxWidth(), color = VanessaPalette.Surface,
            shape = RoundedCornerShape(18.dp),
            border = androidx.compose.foundation.BorderStroke(1.dp, VanessaPalette.Border),
        ) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(11.dp)) { content() }
        }
    }
}

@Composable
private fun SettingsValue(
    label: String,
    value: String,
    status: String? = null,
    statusColor: Color = VanessaPalette.TextSecondary,
) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(label, color = VanessaPalette.TextSecondary, style = MaterialTheme.typography.labelSmall)
            Text(value, color = VanessaPalette.TextPrimary, style = MaterialTheme.typography.bodyMedium)
        }
        if (status != null) Text(status, color = statusColor, style = MaterialTheme.typography.labelSmall)
    }
}

private fun formatBytes(bytes: Long): String = when {
    bytes >= 1024L * 1024 * 1024 -> String.format(Locale.ROOT, "%.2f GB", bytes / (1024.0 * 1024 * 1024))
    bytes >= 1024L * 1024 -> String.format(Locale.ROOT, "%.0f MB", bytes / (1024.0 * 1024))
    else -> "$bytes bytes"
}
