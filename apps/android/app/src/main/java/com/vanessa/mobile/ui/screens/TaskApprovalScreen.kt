package com.vanessa.mobile.ui.screens

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.vanessa.mobile.ui.components.NeonButton
import com.vanessa.mobile.ui.components.NeonSecondaryButton
import com.vanessa.mobile.ui.components.VanessaOrb
import com.vanessa.mobile.ui.state.PendingApproval
import com.vanessa.mobile.ui.theme.VanessaPalette
import com.vanessa.mobile.ui.theme.VanessaRadius
import com.vanessa.mobile.ui.theme.VanessaSpacing
import com.vanessa.mobile.ui.theme.VanessaType
import kotlinx.coroutines.delay
import java.util.Locale

/**
 * Full-screen approval for a protected action on the PC.
 *
 * This replaces the Material dialog that used to interrupt the remote screen.
 * The dialog asked "Approve action on Windows PC?" and put the consequence, the
 * target and the expiry into one paragraph — which is the wrong shape for a
 * decision that cannot be undone. The screen states what will happen, to what,
 * and how long the offer stands, as separate readable facts.
 *
 * Approval and cancellation stay separate controls, and approval only ever
 * completes through the biometric-bound signature: this composable cannot
 * approve anything by itself.
 */
@Composable
internal fun TaskApprovalScreen(
    approval: PendingApproval,
    onApprove: () -> Unit,
    onDeny: () -> Unit,
    busy: Boolean = false,
) {
    val remaining = rememberCountdown(approval.expiresAt)
    val expired = approval.expiresAt > 0L && remaining <= 0L

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(VanessaPalette.Obsidian)
            .windowInsetsPadding(WindowInsets.safeDrawing)
            .verticalScroll(rememberScrollState())
            .padding(horizontal = VanessaSpacing.inset)
            .padding(top = VanessaSpacing.s, bottom = VanessaSpacing.xl),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(modifier = Modifier.size(148.dp), contentAlignment = Alignment.Center) {
            VanessaOrb(size = 148.dp, energy = 0.30f, offline = false, ringCount = 3, description = null)
        }

        Spacer(Modifier.height(6.dp))
        Text("CONFIRM ACTION", color = VanessaPalette.Warning, style = VanessaType.eyebrow)
        Spacer(Modifier.height(10.dp))
        Text(
            text = "Approve this action?",
            color = VanessaPalette.TextPrimary,
            style = VanessaType.heading,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(8.dp))
        Text(
            text = "Vanessa needs your permission before the PC does this.",
            color = VanessaPalette.TextSecondary,
            style = VanessaType.bodySmall,
            textAlign = TextAlign.Center,
        )

        Spacer(Modifier.height(18.dp))
        Surface(
            modifier = Modifier.fillMaxWidth(),
            color = VanessaPalette.Surface.copy(alpha = 0.92f),
            shape = RoundedCornerShape(VanessaRadius.card),
            border = BorderStroke(1.dp, VanessaPalette.Border),
        ) {
            Column(Modifier.padding(VanessaSpacing.m), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                FactRow(label = "Action", value = approval.capability)
                Hairline()
                FactRow(label = "Target", value = approval.targetLabel)
                Hairline()
                FactRow(label = "Effect", value = approval.consequence)
            }
        }

        Spacer(Modifier.height(12.dp))
        Text(
            text = when {
                approval.expiresAt <= 0L -> "This request has no expiry."
                expired -> "This request has expired. The PC will not run it."
                else -> "Expires in ${formatRemaining(remaining)}"
            },
            color = if (expired) VanessaPalette.Error else VanessaPalette.TextDim,
            style = VanessaType.caption,
        )

        Spacer(Modifier.height(22.dp))
        NeonButton(
            text = if (busy) "Waiting for fingerprint…" else "Approve with fingerprint",
            onClick = onApprove,
            modifier = Modifier.fillMaxWidth(),
            enabled = !expired && !busy,
        )
        Spacer(Modifier.height(10.dp))
        NeonSecondaryButton(
            text = "Cancel",
            onClick = onDeny,
            modifier = Modifier.fillMaxWidth(),
            enabled = !busy,
        )
        Spacer(Modifier.height(14.dp))
        Text(
            text = "Your approval is signed on this phone and bound to this exact request, " +
                "so the PC can verify it before it acts. Cancelling sends a denial.",
            color = VanessaPalette.TextDim,
            style = VanessaType.caption,
            textAlign = TextAlign.Center,
        )
        // Deliberately no "back" out of this screen. Leaving here without a
        // decision used to drop a live approval on the floor: the PC kept waiting
        // until the request expired and the user was told nothing. Approving and
        // cancelling are the two ways out, and cancelling tells the PC.
    }
}

@Composable
private fun FactRow(label: String, value: String) {
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(label.uppercase(), color = VanessaPalette.TextDim, style = VanessaType.eyebrow)
        Text(value, color = VanessaPalette.TextPrimary, style = VanessaType.body)
    }
}

@Composable
private fun Hairline() {
    Box(
        Modifier
            .fillMaxWidth()
            .height(1.dp)
            .background(VanessaPalette.Border.copy(alpha = 0.6f)),
    )
}

/** A one-second ticker, so the expiry is a live fact rather than a static string. */
@Composable
private fun rememberCountdown(expiresAt: Long): Long {
    var now by remember(expiresAt) { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(expiresAt) {
        while (true) {
            now = System.currentTimeMillis()
            delay(1000)
        }
    }
    return if (expiresAt <= 0L) 0L else expiresAt - now
}

private fun formatRemaining(millis: Long): String {
    val totalSeconds = (millis / 1000).coerceAtLeast(0)
    val minutes = totalSeconds / 60
    val seconds = totalSeconds % 60
    return String.format(Locale.US, "%d:%02d", minutes, seconds)
}
