package com.vanessa.mobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Apps
import androidx.compose.material.icons.outlined.GraphicEq
import androidx.compose.material.icons.outlined.Menu
import androidx.compose.material.icons.outlined.Send
import androidx.compose.material.icons.outlined.Shield
import androidx.compose.material.icons.outlined.Stop
import androidx.compose.material.icons.outlined.VolumeUp
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.withFrameNanos
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import androidx.compose.ui.unit.sp
import com.vanessa.mobile.ui.components.EnergyWave
import com.vanessa.mobile.ui.components.ProgressRing
import com.vanessa.mobile.ui.components.NeonIconButton
import com.vanessa.mobile.ui.components.NeonTextField
import com.vanessa.mobile.ui.components.NeonSecondaryButton
import com.vanessa.mobile.ui.components.VanessaOrb
import com.vanessa.mobile.ui.theme.VanessaPalette
import com.vanessa.mobile.ui.theme.VanessaType

internal data class VanessaChatMessage(
    val id: Long,
    val fromUser: Boolean,
    val text: String,
)

/**
 * Screens 4–8 of the reconstruction brief, wired to Vanessa's real state.
 *
 * The visual composition follows the reference; execution status is reported
 * conservatively. Local work uses an indeterminate indicator because the
 * local planner does not publish a percentage. Remote PC work uses the
 * separate protocol-driven execution screen, which shows a percentage only
 * when the PC reports one.
 */

// ───────────────────────────── 5 · Chat ─────────────────────────────

@Composable
internal fun ChatScreen(
    inset: Dp,
    modelLoaded: Boolean,
    modelBusy: Boolean,
    assistantBusy: Boolean,
    prompt: String,
    messages: List<VanessaChatMessage>,
    response: String,
    metrics: String,
    speechReady: Boolean,
    onPromptChange: (String) -> Unit,
    onSend: () -> Unit,
    onListen: () -> Unit,
    onSpeakResponse: () -> Unit,
    onNavigate: (String) -> Unit,
) {
    var menuExpanded by remember { mutableStateOf(false) }
    val messageScrollState = rememberScrollState()
    val scope = rememberCoroutineScope()
    val bottomSlop = with(LocalDensity.current) { 48.dp.toPx() }

    // Whether the reader is at the live end of the conversation. Derived from the
    // scroll position rather than assumed, because following every message meant
    // that reading older turns was impossible: each arrival yanked the viewport
    // back to the bottom mid-sentence.
    val atBottom by remember(bottomSlop) {
        derivedStateOf {
            val max = messageScrollState.maxValue
            max == 0 || messageScrollState.value >= max - bottomSlop
        }
    }
    var hasUnread by remember { mutableStateOf(false) }

    LaunchedEffect(messages.size) {
        // Wait until the newly-added row has been measured before reading maxValue;
        // otherwise the first scroll can stop one row short.
        withFrameNanos { }
        if (atBottom) {
            messageScrollState.animateScrollTo(messageScrollState.maxValue)
            hasUnread = false
        } else if (messages.isNotEmpty()) {
            hasUnread = true
        }
    }

    // The thinking row is not a message: only follow it when the reader is already
    // at the live end, and never flag it as unread.
    LaunchedEffect(assistantBusy) {
        if (atBottom) {
            withFrameNanos { }
            messageScrollState.animateScrollTo(messageScrollState.maxValue)
        }
    }

    LaunchedEffect(atBottom) { if (atBottom) hasUnread = false }

    Box(modifier = Modifier.fillMaxSize()) {
        EnergyWave(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .height(250.dp)
                .padding(bottom = 54.dp),
            intensity = if (assistantBusy) 1.05f else 0.5f,
        )

        Column(modifier = Modifier.fillMaxSize().padding(horizontal = inset)) {
            Row(
                modifier = Modifier.fillMaxWidth().height(54.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box {
                    NeonIconButton(
                        icon = Icons.Outlined.Menu,
                        contentDescription = "Open navigation menu",
                        onClick = { menuExpanded = true },
                        diameter = 42.dp,
                    )
                    DropdownMenu(expanded = menuExpanded, onDismissRequest = { menuExpanded = false }) {
                        DropdownMenuItem(
                            text = { Text("Assistant") },
                            onClick = { menuExpanded = false; onNavigate("HOME") },
                        )
                        DropdownMenuItem(
                            text = { Text("My PC") },
                            onClick = { menuExpanded = false; onNavigate("PC") },
                        )
                        DropdownMenuItem(
                            text = { Text("Settings") },
                            onClick = { menuExpanded = false; onNavigate("SETTINGS") },
                        )
                    }
                }
                Spacer(Modifier.weight(1f))
                Text("Vanessa", color = VanessaPalette.TextPrimary, fontSize = 15.sp, fontWeight = FontWeight.Medium)
                Spacer(Modifier.weight(1f))
                NeonIconButton(
                    icon = Icons.Outlined.GraphicEq,
                    contentDescription = "Start voice interaction",
                    onClick = onListen,
                    diameter = 42.dp,
                    highlighted = true,
                )
            }

            Column(
                modifier = Modifier.weight(1f).fillMaxWidth().verticalScroll(messageScrollState),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                if (messages.isEmpty() && !assistantBusy) {
                    Column(
                        modifier = Modifier.fillMaxWidth().padding(top = 18.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        VanessaOrb(size = 148.dp, energy = 0.18f, offline = !modelLoaded, description = "Vanessa orb, idle")
                        Text(
                            "How can I help?",
                            color = VanessaPalette.TextPrimary,
                            fontSize = 24.sp,
                            fontWeight = FontWeight.Medium,
                            textAlign = TextAlign.Center,
                        )
                        Text(
                            if (modelLoaded) "Talk or type. Switch between them anytime."
                            else "Add a local model in Settings to start a conversation.",
                            color = VanessaPalette.TextSecondary,
                            fontSize = 12.sp,
                            textAlign = TextAlign.Center,
                        )
                    }
                }

                messages.forEach { message ->
                    if (message.fromUser) {
                        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                            Surface(
                                modifier = Modifier.fillMaxWidth(0.86f),
                                color = VanessaPalette.SurfaceStrong,
                                shape = RoundedCornerShape(topStart = 18.dp, topEnd = 18.dp, bottomStart = 18.dp, bottomEnd = 5.dp),
                                border = androidx.compose.foundation.BorderStroke(1.dp, VanessaPalette.Border),
                            ) {
                                Text(
                                    message.text,
                                    modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp),
                                    color = VanessaPalette.TextPrimary,
                                    fontSize = 14.sp,
                                    lineHeight = 20.sp,
                                )
                            }
                        }
                    } else {
                        Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            VanessaOrb(size = 30.dp, energy = 0.2f, offline = false, ringCount = 1, showParticles = false, description = "Vanessa response")
                            Surface(
                                modifier = Modifier.weight(1f),
                                color = VanessaPalette.Surface.copy(alpha = 0.94f),
                                shape = RoundedCornerShape(topStart = 5.dp, topEnd = 18.dp, bottomStart = 18.dp, bottomEnd = 18.dp),
                                border = androidx.compose.foundation.BorderStroke(1.dp, VanessaPalette.Border),
                            ) {
                                Column(
                                    modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp),
                                    verticalArrangement = Arrangement.spacedBy(8.dp),
                                ) {
                                    Text(message.text, color = VanessaPalette.TextPrimary, fontSize = 14.sp, lineHeight = 20.sp)
                                    if (message.text == response && (metrics.isNotBlank() || speechReady)) {
                                        Row(verticalAlignment = Alignment.CenterVertically) {
                                            if (metrics.isNotBlank()) {
                                                Text(metrics, modifier = Modifier.weight(1f), color = VanessaPalette.TextSecondary, fontSize = 10.sp)
                                            } else {
                                                Spacer(Modifier.weight(1f))
                                            }
                                            if (speechReady) {
                                                IconButton(onClick = onSpeakResponse, modifier = Modifier.size(34.dp)) {
                                                    Icon(Icons.Outlined.VolumeUp, contentDescription = "Read response aloud", tint = VanessaPalette.TextSecondary, modifier = Modifier.size(18.dp))
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                if (assistantBusy) {
                    Surface(
                        modifier = Modifier.fillMaxWidth(),
                        color = VanessaPalette.Surface.copy(alpha = 0.92f),
                        shape = RoundedCornerShape(18.dp),
                        border = androidx.compose.foundation.BorderStroke(1.dp, VanessaPalette.Border),
                    ) {
                        Row(
                            modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(Icons.Outlined.GraphicEq, contentDescription = null, tint = VanessaPalette.Cyan, modifier = Modifier.size(20.dp))
                            Spacer(Modifier.width(12.dp))
                            Text("Thinking on this device…", modifier = Modifier.weight(1f), color = VanessaPalette.TextPrimary, fontSize = 13.sp)
                            CircularProgressIndicator(modifier = Modifier.size(20.dp), color = VanessaPalette.Cyan, strokeWidth = 2.dp)
                        }
                    }
                }

                if (!modelLoaded) {
                    InlineNotice(
                        if (modelBusy) "The local model is being installed or loaded. Requests will not run until that finishes."
                        else "No local model is active. Vanessa will not run a request until a model is installed.",
                        if (modelBusy) NoticeTone.INFO else NoticeTone.WARNING,
                    )
                }
                Spacer(Modifier.height(4.dp))
            }

            if (hasUnread) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
                    horizontalArrangement = Arrangement.End,
                ) {
                    Surface(
                        color = VanessaPalette.SurfaceStrong.copy(alpha = 0.96f),
                        shape = RoundedCornerShape(999.dp),
                        border = androidx.compose.foundation.BorderStroke(
                            1.dp,
                            VanessaPalette.Cyan.copy(alpha = 0.45f),
                        ),
                        modifier = Modifier.clickable(role = Role.Button) {
                            scope.launch {
                                messageScrollState.animateScrollTo(messageScrollState.maxValue)
                                hasUnread = false
                            }
                        },
                    ) {
                        Text(
                            text = "New messages ↓",
                            modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
                            color = VanessaPalette.Cyan,
                            style = VanessaType.caption,
                        )
                    }
                }
            }

            Composer(
                prompt = prompt,
                enabled = !assistantBusy,
                sendEnabled = modelLoaded && !modelBusy && !assistantBusy && prompt.isNotBlank(),
                onPromptChange = onPromptChange,
                onSend = onSend,
                onChooseSuggestion = { suggestion -> onPromptChange(suggestion) },
            )
            Spacer(Modifier.height(12.dp))
        }
    }
}

@Composable
private fun Composer(
    prompt: String,
    enabled: Boolean,
    sendEnabled: Boolean,
    onPromptChange: (String) -> Unit,
    onSend: () -> Unit,
    onChooseSuggestion: (String) -> Unit,
) {
    var suggestionsExpanded by remember { mutableStateOf(false) }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(999.dp))
            .background(VanessaPalette.SurfaceStrong.copy(alpha = 0.94f))
            .padding(horizontal = 8.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box {
            IconButton(
                onClick = { suggestionsExpanded = true },
                modifier = Modifier.size(40.dp),
                enabled = enabled,
            ) {
                Icon(
                    Icons.Outlined.Apps,
                    contentDescription = "Choose a message suggestion",
                    tint = VanessaPalette.TextSecondary,
                    modifier = Modifier.size(20.dp),
                )
            }
            DropdownMenu(
                expanded = suggestionsExpanded,
                onDismissRequest = { suggestionsExpanded = false },
            ) {
                DropdownMenuItem(
                    text = { Text("Plan my day") },
                    onClick = {
                        suggestionsExpanded = false
                        onChooseSuggestion("Help me plan my day.")
                    },
                )
                DropdownMenuItem(
                    text = { Text("Check my phone status") },
                    onClick = {
                        suggestionsExpanded = false
                        onChooseSuggestion("Check my phone status.")
                    },
                )
                DropdownMenuItem(
                    text = { Text("Check today's calendar") },
                    onClick = {
                        suggestionsExpanded = false
                        onChooseSuggestion("Find my calendar events today.")
                    },
                )
            }
        }
        NeonTextField(
            value = prompt,
            onValueChange = onPromptChange,
            modifier = Modifier.weight(1f),
            placeholder = "Type a message…",
            enabled = enabled,
            singleLine = true,
            minHeight = 42.dp,
            containerColor = Color.Transparent,
            outlineColor = Color.Transparent,
            shape = CircleShape,
            horizontalPadding = 6.dp,
            verticalPadding = 8.dp,
        )
        Box(
            modifier = Modifier
                .size(40.dp)
                .clip(CircleShape)
                .background(
                    if (sendEnabled) {
                        Brush.horizontalGradient(listOf(Color(0xFF2E6BFF), VanessaPalette.Cyan))
                    } else {
                        Brush.horizontalGradient(listOf(VanessaPalette.Border, VanessaPalette.Border))
                    },
                )
                .clickable(enabled = sendEnabled, role = Role.Button, onClick = onSend),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                Icons.Outlined.Send,
                contentDescription = "Send request",
                tint = if (sendEnabled) Color(0xFF04101C) else VanessaPalette.TextSecondary,
                modifier = Modifier.size(18.dp),
            )
        }
    }
}

// ─────────────────────────── 4 · Listening ───────────────────────────

@Composable
internal fun ListeningScreen(
    inset: Dp,
    listening: Boolean,
    speechAvailable: Boolean,
    status: String,
    /** Live draft of the current utterance. Empty while nothing is being heard. */
    draft: String,
    onStop: () -> Unit,
    onClose: () -> Unit,
    onTypeInstead: () -> Unit,
) {
    Box(modifier = Modifier.fillMaxSize()) {
        EnergyWave(
            modifier = Modifier
                .align(Alignment.Center)
                .fillMaxWidth()
                .height(190.dp)
                .offset(y = 110.dp),
            intensity = if (listening) 1.3f else 0.45f,
        )

        Column(modifier = Modifier.fillMaxSize().padding(horizontal = inset).padding(top = 8.dp, bottom = 26.dp)) {
            Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    Icons.Outlined.GraphicEq,
                    contentDescription = null,
                    tint = VanessaPalette.Cyan,
                    modifier = Modifier.size(22.dp),
                )
                Spacer(Modifier.weight(1f))
                NeonIconButton(
                    icon = Icons.Outlined.Close,
                    contentDescription = "Close voice input",
                    onClick = {
                        onStop()
                        onClose()
                    },
                    diameter = 44.dp,
                )
            }

            Spacer(Modifier.height(20.dp))
            Text(
                text = if (listening) "I'm listening…" else "Voice input",
                modifier = Modifier.fillMaxWidth(),
                color = VanessaPalette.TextPrimary,
                fontSize = 21.sp,
                fontWeight = FontWeight.Medium,
                textAlign = TextAlign.Center,
            )

            Spacer(Modifier.height(18.dp))
            Box(modifier = Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                VanessaOrb(
                    size = 172.dp,
                    energy = if (listening) 0.85f else 0.2f,
                    offline = !speechAvailable,
                    description = when {
                        !speechAvailable -> "Vanessa orb. On-device speech is unavailable."
                        listening -> "Vanessa orb. Listening."
                        else -> "Vanessa orb. Voice input idle."
                    },
                )
            }

            Spacer(Modifier.weight(1f))
            Box(modifier = Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                NeonIconButton(
                    icon = Icons.Outlined.Stop,
                    contentDescription = "Stop listening",
                    onClick = onStop,
                    diameter = 66.dp,
                    highlighted = true,
                    enabled = listening,
                )
            }
            Spacer(Modifier.height(14.dp))
            if (draft.isNotBlank()) {
                // The sentence as the recognizer currently has it. Shown in the
                // primary colour because it is the content the user is
                // producing, not a status line about the app.
                Text(
                    draft,
                    modifier = Modifier.fillMaxWidth(),
                    color = VanessaPalette.TextPrimary,
                    fontSize = 15.sp,
                    lineHeight = 22.sp,
                    textAlign = TextAlign.Center,
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                )
                Spacer(Modifier.height(8.dp))
            }
            Text(
                status,
                modifier = Modifier.fillMaxWidth(),
                color = VanessaPalette.TextSecondary,
                fontSize = 11.sp,
                lineHeight = 16.sp,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(6.dp))
            Box(modifier = Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                NeonSecondaryButton(
                    text = if (speechAvailable) "Type instead" else "Type your request instead",
                    onClick = {
                        onStop()
                        onTypeInstead()
                    },
                    modifier = Modifier.fillMaxWidth(),
                    height = 46.dp,
                )
            }
        }
    }
}

// ──────────────────────── 6 · Confirm action ─────────────────────────

@Composable
internal fun ConfirmActionScreen(
    inset: Dp,
    approval: ApprovalRequest?,
    onApprove: () -> Unit,
    onCancel: () -> Unit,
) {
    val request = approval ?: ApprovalRequest(
        title = "Confirm Action",
        body = "There is nothing waiting for your approval.",
        detail = null,
        approveLabel = "Approve",
    )

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = inset)
            .padding(top = 26.dp, bottom = 28.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(
            Icons.Outlined.Shield,
            contentDescription = null,
            tint = VanessaPalette.Cyan,
            modifier = Modifier.size(40.dp),
        )
        Spacer(Modifier.height(14.dp))
        Text(
            request.title,
            color = VanessaPalette.TextPrimary,
            fontSize = 21.sp,
            fontWeight = FontWeight.Medium,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(8.dp))
        Text(
            request.body,
            color = VanessaPalette.TextSecondary,
            fontSize = 13.sp,
            lineHeight = 19.sp,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(horizontal = 12.dp),
        )

        Spacer(Modifier.height(18.dp))
        ConfirmIllustration()
        Spacer(Modifier.height(16.dp))

        if (request.detail != null) {
            Surface(
                modifier = Modifier.fillMaxWidth(),
                color = VanessaPalette.Surface.copy(alpha = 0.9f),
                shape = RoundedCornerShape(16.dp),
                border = androidx.compose.foundation.BorderStroke(1.dp, VanessaPalette.Border),
            ) {
                Text(
                    request.detail,
                    modifier = Modifier.padding(14.dp),
                    color = VanessaPalette.TextSecondary,
                    fontSize = 12.sp,
                    lineHeight = 17.sp,
                )
            }
            Spacer(Modifier.height(18.dp))
        }

        GlowPillButton(
            text = request.approveLabel,
            onClick = onApprove,
            modifier = Modifier.fillMaxWidth(),
            enabled = approval != null,
        )
        Spacer(Modifier.height(10.dp))
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(54.dp)
                .clip(RoundedCornerShape(999.dp))
                .background(VanessaPalette.Surface.copy(alpha = 0.7f))
                .clickable(role = Role.Button, onClick = onCancel),
            contentAlignment = Alignment.Center,
        ) {
            Text(request.cancelLabel, color = VanessaPalette.TextPrimary, fontSize = 14.sp)
        }
    }
}

/**
 * A small holographic stack of files with a lime check — the reference's
 * folder illustration, drawn rather than shipped as an asset so it stays on
 * the palette and scales with density.
 */
@Composable
private fun ConfirmIllustration() {
    androidx.compose.foundation.Canvas(modifier = Modifier.size(width = 220.dp, height = 138.dp)) {
        val unit = size.minDimension / 138f

        // Three overlapping sheets, back to front, as in the reference.
        drawFileSheet(28f * unit, 20f * unit, VanessaPalette.BlueSoft, 0.55f, unit)
        drawFileSheet(18f * unit, 30f * unit, VanessaPalette.Cyan, 0.75f, unit)
        drawFileSheet(8f * unit, 40f * unit, VanessaPalette.Cyan, 0.95f, unit)

        // Lime completion badge on the front sheet's lower-right corner.
        val badgeCenter = Offset(128f * unit, 124f * unit)
        drawCircle(
            brush = Brush.radialGradient(
                colors = listOf(
                    VanessaPalette.Lime.copy(alpha = 0.28f),
                    VanessaPalette.Lime.copy(alpha = 0.10f),
                    Color.Transparent,
                ),
                center = badgeCenter,
                radius = 34f * unit,
            ),
            radius = 34f * unit,
            center = badgeCenter,
        )
        drawCircle(
            color = VanessaPalette.Lime.copy(alpha = 0.9f),
            radius = 18f * unit,
            center = badgeCenter,
            style = Stroke(width = 2f * unit),
        )
        val checkStart = Offset(badgeCenter.x - 7f * unit, badgeCenter.y)
        drawLine(
            color = VanessaPalette.Lime,
            start = checkStart,
            end = Offset(badgeCenter.x - 2f * unit, badgeCenter.y + 6f * unit),
            strokeWidth = 2.4f * unit,
        )
        drawLine(
            color = VanessaPalette.Lime,
            start = Offset(badgeCenter.x - 2f * unit, badgeCenter.y + 6f * unit),
            end = Offset(badgeCenter.x + 8f * unit, badgeCenter.y - 6f * unit),
            strokeWidth = 2.4f * unit,
        )
    }
}


/** One translucent sheet of the approval illustration. */
private fun androidx.compose.ui.graphics.drawscope.DrawScope.drawFileSheet(
    offsetX: Float,
    offsetY: Float,
    tint: Color,
    alpha: Float,
    unit: Float,
) {
    val topLeft = Offset(offsetX, offsetY)
    val sheetSize = Size(120f * unit, 84f * unit)
    val corner = CornerRadius(16f * unit, 16f * unit)
    drawRoundRect(
        color = tint.copy(alpha = alpha * 0.22f),
        topLeft = topLeft,
        size = sheetSize,
        cornerRadius = corner,
    )
    drawRoundRect(
        brush = Brush.linearGradient(
            colors = listOf(
                VanessaPalette.Cyan.copy(alpha = alpha),
                VanessaPalette.Lime.copy(alpha = alpha * 0.7f),
            ),
            start = topLeft,
            end = Offset(topLeft.x + sheetSize.width, topLeft.y + sheetSize.height),
        ),
        topLeft = topLeft,
        size = sheetSize,
        cornerRadius = corner,
        style = Stroke(width = 1.6f * unit),
    )
}

// ──────────────────────── 7 · Executing task ─────────────────────────

@Composable
internal fun ExecutingScreen(
    inset: Dp,
    execution: ExecutionState?,
    onClose: () -> Unit,
) {
    val state = execution ?: ExecutionState(
        title = "Executing Task…",
        subtitle = "Waiting for work to start",
        steps = emptyList(),
    )

    Box(modifier = Modifier.fillMaxSize()) {
        EnergyWave(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .height(200.dp)
                .padding(bottom = 10.dp),
            intensity = 0.7f,
        )

        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = inset)
                .padding(top = 8.dp, bottom = 24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    Icons.Outlined.GraphicEq,
                    contentDescription = null,
                    tint = VanessaPalette.Cyan,
                    modifier = Modifier.size(22.dp),
                )
                Spacer(Modifier.weight(1f))
                IconButton(onClick = onClose, modifier = Modifier.size(44.dp)) {
                    Icon(
                        Icons.Outlined.Close,
                        contentDescription = "Close progress and keep working",
                        tint = VanessaPalette.TextPrimary,
                    )
                }
            }

            Spacer(Modifier.height(14.dp))
            Text(
                state.title,
                color = VanessaPalette.TextPrimary,
                fontSize = 21.sp,
                fontWeight = FontWeight.Medium,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(6.dp))
            Text(
                state.subtitle,
                color = VanessaPalette.TextSecondary,
                fontSize = 12.sp,
                lineHeight = 17.sp,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(4.dp))
            Text(
                "Working locally on this device. No remote progress percentage is available for this task.",
                color = VanessaPalette.TextDim,
                fontSize = 10.sp,
                lineHeight = 15.sp,
                textAlign = TextAlign.Center,
            )

            Spacer(Modifier.height(12.dp))
            Box(modifier = Modifier.size(228.dp), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(
                    modifier = Modifier.fillMaxSize().padding(22.dp),
                    color = VanessaPalette.Cyan,
                    trackColor = VanessaPalette.Border,
                    strokeWidth = 2.5.dp,
                )
                VanessaOrb(
                    size = 132.dp,
                    energy = 0.55f,
                    offline = false,
                    description = "Vanessa orb. Working.",
                )
            }

            Spacer(Modifier.height(10.dp))
            Column(
                modifier = Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                state.steps.forEach { step -> ChecklistRow(step) }
            }
        }
    }
}

@Composable
private fun ChecklistRow(step: FlowStep) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(
            modifier = Modifier
                .size(22.dp)
                .clip(CircleShape)
                .background(
                    when (step.state) {
                        FlowStepState.DONE -> VanessaPalette.Lime.copy(alpha = 0.18f)
                        FlowStepState.ACTIVE -> VanessaPalette.Cyan.copy(alpha = 0.18f)
                        FlowStepState.PENDING -> VanessaPalette.SurfaceStrong
                    },
                ),
            contentAlignment = Alignment.Center,
        ) {
            when (step.state) {
                FlowStepState.DONE -> Text("✓", color = VanessaPalette.Lime, fontSize = 12.sp)
                FlowStepState.ACTIVE -> CircularProgressIndicator(
                    modifier = Modifier.size(12.dp),
                    color = VanessaPalette.Cyan,
                    strokeWidth = 1.6.dp,
                )
                FlowStepState.PENDING -> Box(
                    modifier = Modifier
                        .size(6.dp)
                        .clip(CircleShape)
                        .background(VanessaPalette.TextSecondary.copy(alpha = 0.5f)),
                )
            }
        }
        Spacer(Modifier.width(12.dp))
        Text(
            step.label,
            color = if (step.state == FlowStepState.PENDING) VanessaPalette.TextDim else VanessaPalette.TextPrimary,
            fontSize = 13.sp,
        )
    }
}

// ───────────────────────── 8 · Success ──────────────────────────────

@Composable
internal fun SuccessScreen(
    inset: Dp,
    completion: CompletionState,
    onDone: () -> Unit,
) {
    Box(modifier = Modifier.fillMaxSize()) {
        EnergyWave(
            modifier = Modifier
                .align(Alignment.Center)
                .fillMaxWidth()
                .height(260.dp)
                .offset(y = 80.dp),
            intensity = 1.15f,
        )

        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = inset)
                .padding(top = 30.dp, bottom = 28.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            VanessaOrb(
                size = 216.dp,
                energy = 0.7f,
                offline = false,
                showCheck = true,
                description = "Vanessa orb with a completion check",
            )
            Spacer(Modifier.height(18.dp))
            Text(
                completion.title,
                color = VanessaPalette.TextPrimary,
                fontSize = 23.sp,
                fontWeight = FontWeight.Medium,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(6.dp))
            Text(
                completion.body,
                color = VanessaPalette.TextSecondary,
                fontSize = 13.sp,
                lineHeight = 19.sp,
                textAlign = TextAlign.Center,
            )
            if (completion.detail != null) {
                Spacer(Modifier.height(10.dp))
                Text(
                    completion.detail,
                    color = VanessaPalette.TextDim,
                    fontSize = 11.sp,
                    lineHeight = 16.sp,
                    textAlign = TextAlign.Center,
                )
            }
            Spacer(Modifier.weight(1f))
            GlowPillButton(
                text = "Great!",
                onClick = onDone,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}
