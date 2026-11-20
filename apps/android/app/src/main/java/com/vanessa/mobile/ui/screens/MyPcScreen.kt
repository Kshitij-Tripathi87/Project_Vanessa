package com.vanessa.mobile.ui.screens

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
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
import androidx.compose.material.icons.outlined.QrCode2
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.vanessa.mobile.ui.components.NeonButton
import com.vanessa.mobile.ui.components.NeonIconButton
import com.vanessa.mobile.ui.components.NeonSecondaryButton
import com.vanessa.mobile.ui.state.PcCapability
import com.vanessa.mobile.ui.state.PcLink
import com.vanessa.mobile.ui.state.PcUiState
import com.vanessa.mobile.ui.theme.VanessaPalette
import com.vanessa.mobile.ui.theme.VanessaRadius
import com.vanessa.mobile.ui.theme.VanessaSpacing
import com.vanessa.mobile.ui.theme.VanessaType

/**
 * My PC.
 *
 * Three facts, kept apart, because they are true at different times:
 *
 *  - **Pairing** is stored on the phone and survives being offline.
 *  - **The link** is what the socket is doing right now.
 *  - **Capabilities** are what the PC advertised *for this session*, and are
 *    shown only once its manifest has arrived.
 *
 * The previous dashboard collapsed all three into one sentence and two fixed
 * buttons. It said "not paired" even when a PC was paired, and offered "Open
 * Chrome on PC" whether or not the PC had that capability. Both are fixed here
 * by not drawing anything the state does not support.
 */
@Composable
internal fun MyPcScreen(
    state: PcUiState,
    qrPayload: String,
    onQrPayloadChange: (String) -> Unit,
    onScanQr: () -> Unit,
    onPairWithPastedData: () -> Unit,
    onReconnect: () -> Unit,
    onDisconnect: () -> Unit,
    onRunCapability: (PcCapability) -> Unit,
    busy: Boolean,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var showPasteField by remember { mutableStateOf(false) }

    Column(
        modifier = modifier
            .fillMaxSize()
            .windowInsetsPadding(WindowInsets.safeDrawing)
            .imePadding()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = VanessaSpacing.inset)
            .padding(top = 8.dp, bottom = 28.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            NeonIconButton(
                icon = Icons.Outlined.ArrowBack,
                contentDescription = "Back to assistant",
                onClick = onBack,
                diameter = 44.dp,
            )
            Spacer(Modifier.width(12.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text("MY PC", color = VanessaPalette.Cyan, style = VanessaType.eyebrow)
                Text(
                    text = state.identity?.name ?: "Windows companion",
                    color = VanessaPalette.TextPrimary,
                    style = VanessaType.heading,
                )
            }
            LinkPill(state.link)
        }

        // ---- stored pairing -------------------------------------------------
        Card {
            Text("PAIRED PC", color = VanessaPalette.TextDim, style = VanessaType.eyebrow)
            Spacer(Modifier.height(8.dp))
            val identity = state.identity
            if (identity == null) {
                Text(
                    "No PC is paired with this phone yet.",
                    color = VanessaPalette.TextSecondary,
                    style = VanessaType.body,
                )
                Spacer(Modifier.height(4.dp))
                Text(
                    "Scan the QR code shown in Vanessa on Windows to pair.",
                    color = VanessaPalette.TextDim,
                    style = VanessaType.caption,
                )
            } else {
                Text(identity.name, color = VanessaPalette.TextPrimary, style = VanessaType.cardTitle)
                if (identity.endpoint.isNotBlank()) {
                    Text(
                        identity.endpoint,
                        color = VanessaPalette.TextSecondary,
                        style = VanessaType.caption,
                    )
                }
                if (identity.fingerprint.isNotBlank()) {
                    Spacer(Modifier.height(6.dp))
                    Text("KEY FINGERPRINT", color = VanessaPalette.TextDim, style = VanessaType.eyebrow)
                    Text(
                        identity.shortFingerprint,
                        color = VanessaPalette.TextSecondary,
                        style = VanessaType.caption,
                    )
                }
            }
            Spacer(Modifier.height(10.dp))
            Text(state.detail, color = VanessaPalette.TextDim, style = VanessaType.caption)
        }

        // ---- link actions ---------------------------------------------------
        if (state.paired) {
            NeonButton(
                text = when (state.link) {
                    PcLink.CONNECTED -> "Connected"
                    PcLink.CONNECTING, PcLink.RECONNECTING -> "Connecting…"
                    PcLink.DISCONNECTED -> "Reconnect"
                    else -> "Connect to PC"
                },
                leadingIcon = Icons.Outlined.Refresh,
                onClick = onReconnect,
                enabled = state.canReconnect && !busy,
                modifier = Modifier.fillMaxWidth(),
            )
        }

        NeonSecondaryButton(
            text = if (state.paired) "Pair a different PC" else "Pair with Windows",
            leadingIcon = Icons.Outlined.QrCode2,
            onClick = onScanQr,
            enabled = !busy,
            modifier = Modifier.fillMaxWidth(),
        )

        // A keyboard fallback for the camera, kept out of the way until asked for.
        Text(
            text = if (showPasteField) "Hide pair data" else "Paste pair data instead",
            color = VanessaPalette.TextDim,
            style = VanessaType.caption,
            modifier = Modifier
                .fillMaxWidth()
                .clickable(role = Role.Button) { showPasteField = !showPasteField },
            textAlign = TextAlign.Center,
        )

        if (showPasteField) {
            OutlinedTextField(
                value = qrPayload,
                onValueChange = onQrPayloadChange,
                modifier = Modifier.fillMaxWidth(),
                label = { Text("PC pair data", style = VanessaType.caption) },
                placeholder = { Text("Paste the JSON from the pairing window", style = VanessaType.caption) },
                minLines = 3,
                maxLines = 6,
                enabled = !busy,
                textStyle = VanessaType.bodySmall.copy(color = VanessaPalette.TextPrimary),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = VanessaPalette.Cyan,
                    unfocusedBorderColor = VanessaPalette.Border,
                    focusedContainerColor = VanessaPalette.CardDeep,
                    unfocusedContainerColor = VanessaPalette.CardDeep,
                    focusedLabelColor = VanessaPalette.Cyan,
                    unfocusedLabelColor = VanessaPalette.TextDim,
                ),
            )
            Spacer(Modifier.height(8.dp))
            NeonSecondaryButton(
                text = "Pair with this data",
                onClick = onPairWithPastedData,
                enabled = qrPayload.isNotBlank() && !busy,
                modifier = Modifier.fillMaxWidth(),
            )
        }

        // ---- capabilities ---------------------------------------------------
        Card {
            Text("CAPABILITIES", color = VanessaPalette.TextDim, style = VanessaType.eyebrow)
            Spacer(Modifier.height(8.dp))
            when {
                state.manifestReceived && state.capabilities.isEmpty() -> Text(
                    "The PC's manifest lists no capabilities.",
                    color = VanessaPalette.TextSecondary,
                    style = VanessaType.bodySmall,
                )

                state.manifestReceived -> state.capabilities.forEach { capability ->
                    CapabilityRow(
                        capability = capability,
                        runnable = capability.name in RUNNABLE,
                        enabled = state.link == PcLink.CONNECTED && !busy,
                        onRun = { onRunCapability(capability) },
                    )
                }

                state.link == PcLink.CONNECTED -> Text(
                    "Waiting for the PC's manifest.",
                    color = VanessaPalette.TextSecondary,
                    style = VanessaType.bodySmall,
                )

                else -> Text(
                    "Capabilities appear after the PC sends its manifest over a connected session.",
                    color = VanessaPalette.TextSecondary,
                    style = VanessaType.bodySmall,
                )
            }
        }

        if (state.paired) {
            Text(
                text = "Forget this PC",
                color = VanessaPalette.TextDim,
                style = VanessaType.caption,
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable(role = Role.Button, onClick = onDisconnect)
                    .padding(vertical = 8.dp),
                textAlign = TextAlign.Center,
            )
            Text(
                text = "Forgetting removes the stored pairing. The PC must approve this phone again.",
                color = VanessaPalette.TextDim,
                style = VanessaType.caption,
                textAlign = TextAlign.Center,
            )
        }
    }
}

/** The two capabilities this phone knows how to invoke without arguments. */
private val RUNNABLE = setOf("system_status", "open_app")

@Composable
private fun CapabilityRow(
    capability: PcCapability,
    runnable: Boolean,
    enabled: Boolean,
    onRun: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(capability.name, color = VanessaPalette.TextPrimary, style = VanessaType.cardTitle)
            if (capability.description.isNotBlank()) {
                Text(
                    capability.description,
                    color = VanessaPalette.TextSecondary,
                    style = VanessaType.caption,
                )
            }
        }
        when {
            !runnable -> Text(
                "Listed",
                color = VanessaPalette.TextDim,
                style = VanessaType.caption,
            )

            else -> Text(
                text = "Run",
                color = if (enabled) VanessaPalette.Cyan else VanessaPalette.TextDim,
                style = VanessaType.cardTitle,
                modifier = Modifier.clickable(enabled = enabled, role = Role.Button, onClick = onRun),
            )
        }
    }
}

@Composable
private fun LinkPill(link: PcLink) {
    val (label, color) = when (link) {
        PcLink.CONNECTED -> "Connected" to VanessaPalette.Lime
        PcLink.CONNECTING -> "Connecting" to VanessaPalette.Cyan
        PcLink.RECONNECTING -> "Reconnecting" to VanessaPalette.Cyan
        PcLink.DISCONNECTED -> "Disconnected" to VanessaPalette.Warning
        PcLink.ERROR -> "Problem" to VanessaPalette.Error
        PcLink.UNPAIRED -> "Not paired" to VanessaPalette.TextDim
    }
    Row(
        modifier = Modifier
            .background(VanessaPalette.CardDeep, RoundedCornerShape(VanessaRadius.chip))
            .padding(horizontal = 10.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Box(Modifier.size(7.dp).background(color, CircleShape))
        Text(label, color = color, style = VanessaType.caption)
    }
}

@Composable
private fun Card(content: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = VanessaPalette.Surface.copy(alpha = 0.94f),
        shape = RoundedCornerShape(VanessaRadius.card),
        border = BorderStroke(1.dp, VanessaPalette.Border),
    ) {
        Column(Modifier.padding(VanessaSpacing.m), content = content)
    }
}
