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
import com.vanessa.mobile.model.InstalledModel
import com.vanessa.mobile.profile.DeviceProfile
import java.io.File
import java.util.Locale

internal object VanessaPalette {
    val Brand = Color(0xFF0B5FFF)
    val Background = Color(0xFF0A0B0F)
    val Surface = Color(0xFF111318)
    val SurfaceStrong = Color(0xFF171B22)
    val Border = Color(0xFF23262D)
    val TextPrimary = Color(0xFFF5F7FA)
    val TextSecondary = Color(0xFF9AA6B2)
    val Success = Color(0xFF22C55E)
    val Error = Color(0xFFEF4444)
    val Warning = Color(0xFFF59E0B)
}

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
    pairingNotice: String?,
    onNavigate: (String) -> Unit,
    onPromptChange: (String) -> Unit,
    onRunAssistant: () -> Unit,
    onSpeakRequest: () -> Unit,
    onStopSpeech: () -> Unit,
    onSpeakResponse: () -> Unit,
    onRefresh: () -> Unit,
    onStartPairing: () -> Unit,
    onDismissPairingNotice: () -> Unit,
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
                        "VOICE" -> VoiceScreen(
                            inset, modelLoaded, modelBusy, prompt, assistantResponse, assistantMetrics,
                            assistantBusy, speechReady, speechStatus, speechInputStatus,
                            onDeviceSpeechAvailable, voiceListening, onNavigate, onPromptChange,
                            onRunAssistant, onSpeakRequest, onStopSpeech, onSpeakResponse,
                        )
                        "PAIRING" -> PairingScreen(
                            inset, pairingNotice, onNavigate, onStartPairing, onDismissPairingNotice,
                        )
                        "PC" -> PcDashboardScreen(inset, onNavigate)
                        "SETTINGS" -> SettingsScreen(
                            inset, profile, model, modelStatus, inferenceAvailable, modelLoaded,
                            speechReady, speechStatus, speechInputStatus, onDeviceSpeechAvailable,
                            microphonePermissionGranted, onNavigate, onRefresh,
                        )
                        else -> HomeScreen(
                            inset, profile, model, modelStatus, modelLoaded, modelBusy,
                            assistantBusy, prompt, onNavigate, onPromptChange,
                            onRunAssistant, onSpeakRequest,
                        )
                    }
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
            VanessaOrb(116.dp, active = false, offline = false)
            Text("VANESSA", color = VanessaPalette.TextPrimary, style = MaterialTheme.typography.headlineMedium, letterSpacing = 4.sp)
            Text("Local assistant", color = VanessaPalette.TextSecondary, style = MaterialTheme.typography.bodyMedium)
            Spacer(Modifier.height(8.dp))
            Text(message, color = VanessaPalette.TextSecondary, style = MaterialTheme.typography.labelSmall)
        }
    }
}

@Composable
private fun HomeScreen(
    inset: Dp,
    profile: DeviceProfile?,
    model: InstalledModel?,
    modelStatus: String,
    modelLoaded: Boolean,
    modelBusy: Boolean,
    assistantBusy: Boolean,
    prompt: String,
    onNavigate: (String) -> Unit,
    onPromptChange: (String) -> Unit,
    onRunAssistant: () -> Unit,
    onSpeakRequest: () -> Unit,
) {
    var menuExpanded by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())
            .padding(horizontal = inset).padding(top = 8.dp, bottom = 30.dp),
        verticalArrangement = Arrangement.spacedBy(18.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().height(52.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(modifier = Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
                IconButton(onClick = { menuExpanded = true }, modifier = Modifier.size(48.dp)) {
                    Icon(Icons.Outlined.Menu, contentDescription = "Open navigation menu", tint = VanessaPalette.TextPrimary)
                }
                DropdownMenu(expanded = menuExpanded, onDismissRequest = { menuExpanded = false }) {
                    DropdownMenuItem(text = { Text("Assistant") }, onClick = { menuExpanded = false; onNavigate("HOME") })
                    DropdownMenuItem(text = { Text("My PC") }, onClick = { menuExpanded = false; onNavigate("PC") })
                    DropdownMenuItem(text = { Text("Settings") }, onClick = { menuExpanded = false; onNavigate("SETTINGS") })
                }
            }
            Box(modifier = Modifier.weight(1f), contentAlignment = Alignment.Center) {
                Text(
                    "V",
                    color = VanessaPalette.TextPrimary,
                    style = MaterialTheme.typography.headlineMedium,
                    fontWeight = androidx.compose.ui.text.font.FontWeight.Medium,
                    letterSpacing = 0.sp,
                )
            }
            Box(modifier = Modifier.weight(1f), contentAlignment = Alignment.CenterEnd) {
                IconButton(onClick = { onNavigate("SETTINGS") }, modifier = Modifier.size(48.dp)) {
                    Icon(Icons.Outlined.Settings, contentDescription = "Open settings", tint = VanessaPalette.TextSecondary)
                }
            }
        }

        Column(
            modifier = Modifier.fillMaxWidth(),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(9.dp),
        ) {
            Spacer(Modifier.height(4.dp))
            VanessaOrb(116.dp, active = assistantBusy, offline = !modelLoaded)
            Text("How can I help?", color = VanessaPalette.TextPrimary, style = MaterialTheme.typography.titleLarge, textAlign = TextAlign.Center)
            Text(
                when {
                    modelBusy -> "Starting local model…"
                    modelLoaded -> "Local model is ready on this device"
                    model != null -> "Model detected · Runtime not ready"
                    else -> "No local model detected"
                },
                color = if (modelLoaded) VanessaPalette.Success else VanessaPalette.TextSecondary,
                style = MaterialTheme.typography.labelSmall,
                textAlign = TextAlign.Center,
            )
        }

        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            OutlinedTextField(
                value = prompt,
                onValueChange = onPromptChange,
                modifier = Modifier.weight(1f).height(58.dp),
                singleLine = true,
                placeholder = { Text("Ask Vanessa…", color = VanessaPalette.TextSecondary) },
                enabled = !assistantBusy,
                shape = RoundedCornerShape(14.dp),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = VanessaPalette.Brand,
                    unfocusedBorderColor = VanessaPalette.Border,
                    focusedTextColor = VanessaPalette.TextPrimary,
                    unfocusedTextColor = VanessaPalette.TextPrimary,
                    cursorColor = VanessaPalette.Brand,
                    focusedContainerColor = VanessaPalette.Surface,
                    unfocusedContainerColor = VanessaPalette.Surface,
                ),
                trailingIcon = {
                    IconButton(
                        onClick = { onNavigate("VOICE"); onSpeakRequest() },
                        enabled = !assistantBusy,
                        modifier = Modifier.size(48.dp),
                    ) {
                        Icon(Icons.Outlined.Mic, contentDescription = "Start voice interaction", tint = VanessaPalette.TextSecondary)
                    }
                },
            )
            Button(
                onClick = { onNavigate("VOICE"); onRunAssistant() },
                enabled = modelLoaded && !assistantBusy && prompt.isNotBlank(),
                modifier = Modifier.size(54.dp),
                shape = RoundedCornerShape(14.dp),
                colors = ButtonDefaults.buttonColors(containerColor = VanessaPalette.Brand),
            ) {
                Icon(Icons.Outlined.Send, contentDescription = "Send request")
            }
        }

        SectionHeading("MY DEVICES")
        Column(modifier = Modifier.fillMaxWidth()) {
            DeviceRow(
                icon = { Icon(Icons.Outlined.PhoneAndroid, contentDescription = null) },
                title = profile?.let { "${it.manufacturer} ${it.model}" } ?: "My Device",
                subtitle = profile?.let {
                    "Android API ${it.apiLevel} · Battery ${it.batteryPercent?.let { pct -> pct.toString() + "%" } ?: "Unknown"}"
                } ?: "This phone · Checking device status",
                status = "On device",
                statusColor = VanessaPalette.Success,
            )
            ThinDivider()
            DeviceRow(
                icon = { Icon(Icons.Outlined.Computer, contentDescription = null) },
                title = "My PC",
                subtitle = "Windows companion",
                status = "Not paired",
                statusColor = VanessaPalette.TextSecondary,
                onClick = { onNavigate("PC") },
            )
        }

        Row(
            modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp))
                .background(VanessaPalette.SurfaceStrong)
                .clickable { onNavigate("PC") }
                .padding(horizontal = 14.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("Connect a Windows PC", modifier = Modifier.weight(1f), color = VanessaPalette.TextSecondary, style = MaterialTheme.typography.bodyMedium)
            Icon(Icons.Outlined.ChevronRight, contentDescription = "Open PC dashboard", tint = VanessaPalette.TextSecondary)
        }
    }
}

@Composable
private fun VoiceScreen(
    inset: Dp,
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
    onNavigate: (String) -> Unit,
    onPromptChange: (String) -> Unit,
    onRunAssistant: () -> Unit,
    onSpeakRequest: () -> Unit,
    onStopSpeech: () -> Unit,
    onSpeakResponse: () -> Unit,
) {
    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())
            .padding(horizontal = inset).padding(top = 12.dp, bottom = 28.dp),
        verticalArrangement = Arrangement.spacedBy(20.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { onNavigate("HOME") }) {
                Icon(Icons.Outlined.ArrowBack, contentDescription = "Back to assistant home", tint = VanessaPalette.TextPrimary)
            }
            Text("VOICE", color = VanessaPalette.TextSecondary, style = MaterialTheme.typography.labelLarge, letterSpacing = 1.5.sp)
            Spacer(Modifier.weight(1f))
            StatusPill(if (modelLoaded) "LOCAL MODEL READY" else "MODEL UNAVAILABLE", if (modelLoaded) VanessaPalette.Success else VanessaPalette.Warning)
        }

        Column(
            modifier = Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(
                if (voiceListening) "Listening" else "Voice interaction",
                color = VanessaPalette.TextPrimary,
                style = MaterialTheme.typography.displaySmall,
                textAlign = TextAlign.Center,
            )
            Text(
                "Speak a command or type instead.",
                color = VanessaPalette.TextSecondary,
                style = MaterialTheme.typography.bodyMedium,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(8.dp))
            VanessaOrb(152.dp, active = voiceListening || assistantBusy, offline = !modelLoaded)
            Text(
                when { voiceListening -> "Listening…"; assistantBusy -> "Thinking on this device…"; !onDeviceSpeechAvailable -> "On-device speech unavailable"; else -> "Voice input is user initiated" },
                color = if (voiceListening) VanessaPalette.Brand else VanessaPalette.TextSecondary,
                style = MaterialTheme.typography.bodyMedium,
            )
        }

        if (assistantResponse.isNotBlank()) {
            Surface(
                modifier = Modifier.fillMaxWidth(), color = VanessaPalette.Surface,
                shape = RoundedCornerShape(18.dp),
                border = androidx.compose.foundation.BorderStroke(1.dp, VanessaPalette.Border),
            ) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("VANESSA", modifier = Modifier.weight(1f), color = VanessaPalette.TextSecondary, style = MaterialTheme.typography.labelSmall, letterSpacing = 1.2.sp)
                        if (speechReady) {
                            IconButton(onClick = onSpeakResponse, modifier = Modifier.size(40.dp)) {
                                Icon(Icons.Outlined.VolumeUp, contentDescription = "Read response aloud", tint = VanessaPalette.TextSecondary)
                            }
                        }
                    }
                    Text(assistantResponse, color = VanessaPalette.TextPrimary, style = MaterialTheme.typography.bodyLarge)
                    if (assistantMetrics.isNotBlank()) Text(assistantMetrics, color = VanessaPalette.TextSecondary, style = MaterialTheme.typography.labelSmall)
                }
            }
        }

        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            OutlinedTextField(
                value = prompt, onValueChange = onPromptChange, modifier = Modifier.fillMaxWidth(),
                placeholder = { Text("Type your request…", color = VanessaPalette.TextSecondary) },
                minLines = 2, maxLines = 5, enabled = !assistantBusy,
                shape = RoundedCornerShape(16.dp),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = VanessaPalette.Brand, unfocusedBorderColor = VanessaPalette.Border,
                    focusedTextColor = VanessaPalette.TextPrimary, unfocusedTextColor = VanessaPalette.TextPrimary,
                    cursorColor = VanessaPalette.Brand, focusedContainerColor = VanessaPalette.Surface,
                    unfocusedContainerColor = VanessaPalette.Surface,
                ),
            )
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                Button(
                    onClick = if (voiceListening) onStopSpeech else onSpeakRequest,
                    enabled = voiceListening || (onDeviceSpeechAvailable && !assistantBusy),
                    modifier = Modifier.weight(1f).height(54.dp), shape = RoundedCornerShape(14.dp),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = if (voiceListening) VanessaPalette.SurfaceStrong else VanessaPalette.Brand,
                        contentColor = VanessaPalette.TextPrimary,
                        disabledContainerColor = VanessaPalette.SurfaceStrong,
                        disabledContentColor = VanessaPalette.TextSecondary,
                    ),
                ) {
                    Icon(if (voiceListening) Icons.Outlined.Stop else Icons.Outlined.Mic, contentDescription = null)
                    Spacer(Modifier.width(8.dp))
                    Text(if (voiceListening) "Stop listening" else "Speak")
                }
                Button(
                    onClick = onRunAssistant, enabled = modelLoaded && !assistantBusy && prompt.isNotBlank(),
                    modifier = Modifier.size(54.dp), shape = RoundedCornerShape(14.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = VanessaPalette.Brand),
                ) { Icon(Icons.Outlined.Send, contentDescription = "Send request") }
            }
            Text(speechInputStatus, color = VanessaPalette.TextSecondary, style = MaterialTheme.typography.labelSmall)
            Text("Speech output: $speechStatus", color = VanessaPalette.TextSecondary, style = MaterialTheme.typography.labelSmall)
            if (!modelLoaded) {
                InlineNotice("No active local model. Your request will not run until the model is available.", NoticeTone.WARNING)
            }
            if (modelBusy) Text("Loading local model…", color = VanessaPalette.TextSecondary, style = MaterialTheme.typography.labelSmall)
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
                    Text("Secure pairing unavailable")
                }
                Text(
                    "This prototype build does not yet expose the authenticated v2 pairing flow.",
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
            StatusPill("NOT PAIRED", VanessaPalette.TextSecondary)
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
                Text("No PC paired", color = VanessaPalette.TextPrimary, style = MaterialTheme.typography.titleLarge)
                Text(
                    "Pair a Windows companion to see its identity, connection state, and supported actions here.",
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
                DeviceMetricRow(Icons.Outlined.Memory, "Processor", "Unavailable until connected")
                ThinDivider()
                DeviceMetricRow(Icons.Outlined.Storage, "Memory", "Unavailable until connected")
                ThinDivider()
                DeviceMetricRow(Icons.Outlined.WifiOff, "Network", "No active PC connection")
            }
        }
        InlineNotice(
            "PC metrics and actions appear only when the authenticated companion supplies them. No placeholder values are shown.",
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
    onNavigate: (String) -> Unit,
    onRefresh: () -> Unit,
) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val versionName = runCatching {
        context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "0.1.0"
    }.getOrDefault("0.1.0")

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
            SettingsValue("Paired PC", "None")
            Text("Authenticated Windows pairing is not enabled in this prototype build.", color = VanessaPalette.TextSecondary, style = MaterialTheme.typography.bodyMedium)
            TextButton(onClick = { onNavigate("PAIRING") }) {
                Text("Open pairing")
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
        Icon(icon, contentDescription = null, tint = if (selected) VanessaPalette.Brand else VanessaPalette.TextSecondary, modifier = Modifier.size(22.dp))
        Text(label, color = if (selected) VanessaPalette.TextPrimary else VanessaPalette.TextSecondary, style = MaterialTheme.typography.labelSmall)
    }
}

@Composable
private fun VanessaOrb(size: Dp, active: Boolean, offline: Boolean) {
    val scale by animateFloatAsState(
        targetValue = if (active) 1.035f else 1f,
        animationSpec = tween(durationMillis = 260),
        label = "vanessa-orb-scale",
    )
    val description = when {
        offline -> "Vanessa orb. Local model unavailable."
        active -> "Vanessa orb. Assistant is active."
        else -> "Vanessa orb. Assistant is idle."
    }
    Canvas(
        modifier = Modifier.size(size).graphicsLayer { scaleX = scale; scaleY = scale }
            .semantics { this.contentDescription = description },
    ) {
        val radius = this.size.minDimension / 2f
        val center = Offset(this.size.width / 2f, this.size.height / 2f)
        val base = if (offline) Color(0xFF20242B) else Color(0xFF111A2B)
        drawCircle(
            brush = Brush.radialGradient(
                colors = listOf(Color(0xFF3C5275).copy(alpha = if (active) 0.62f else 0.36f), base, Color(0xFF080A0E)),
                center = center + Offset(-radius * 0.24f, -radius * 0.34f), radius = radius * 1.15f,
            ),
            radius = radius * 0.88f, center = center,
        )
        drawCircle(
            brush = Brush.radialGradient(
                colors = listOf(Color(0xFF8BA7D4).copy(alpha = 0.16f), Color.Transparent),
                center = center + Offset(-radius * 0.28f, -radius * 0.36f), radius = radius * 0.72f,
            ),
            radius = radius * 0.72f, center = center,
        )
        drawCircle(color = Color.White.copy(alpha = 0.24f), radius = radius * 0.88f, center = center, style = Stroke(width = 1.15.dp.toPx()))
        drawArc(
            brush = Brush.sweepGradient(
                colors = listOf(Color.Transparent, VanessaPalette.Brand.copy(alpha = if (active) 0.92f else 0.45f), Color.Transparent),
                center = center,
            ),
            startAngle = 205f, sweepAngle = 126f, useCenter = false,
            topLeft = Offset(center.x - radius * 0.89f, center.y - radius * 0.89f),
            size = Size(radius * 1.78f, radius * 1.78f),
            style = Stroke(width = if (active) 2.2.dp.toPx() else 1.4.dp.toPx()),
        )
        drawCircle(
            color = Color.White.copy(alpha = 0.12f), radius = radius * 0.18f,
            center = center + Offset(-radius * 0.28f, -radius * 0.34f),
        )
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

private enum class NoticeTone { INFO, WARNING }

@Composable
private fun InlineNotice(text: String, tone: NoticeTone, onDismiss: (() -> Unit)? = null) {
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
