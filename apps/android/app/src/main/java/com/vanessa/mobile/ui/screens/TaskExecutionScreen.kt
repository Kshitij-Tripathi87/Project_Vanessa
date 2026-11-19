package com.vanessa.mobile.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.vanessa.mobile.ui.components.EnergyWave
import com.vanessa.mobile.ui.components.NeonSecondaryButton
import com.vanessa.mobile.ui.components.ProgressRing
import com.vanessa.mobile.ui.components.VanessaOrb
import com.vanessa.mobile.ui.state.RemoteTaskPhase
import com.vanessa.mobile.ui.theme.VanessaPalette
import com.vanessa.mobile.ui.theme.VanessaType

/**
 * What the PC is doing right now.
 *
 * Every line on this screen came from a `task.progress` payload: the state
 * label, the summary, the step history, and — only when the PC sent it — the
 * percentage. When no percentage has been reported the ring is replaced by the
 * energy wave, because a determinate ring frozen at an invented fraction is
 * exactly the fake progress indicator the brief forbids.
 */
@Composable
internal fun TaskExecutionScreen(
    phase: RemoteTaskPhase.Running,
    onStop: () -> Unit,
    canStop: Boolean = true,
) {
    val percent = phase.percentComplete
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(VanessaPalette.Obsidian)
            .windowInsetsPadding(WindowInsets.safeDrawing)
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 22.dp)
            .padding(top = 12.dp, bottom = 28.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Spacer(Modifier.height(10.dp))
        Text("EXECUTING TASK", color = VanessaPalette.Cyan, style = VanessaType.eyebrow)
        Spacer(Modifier.height(14.dp))

        Box(modifier = Modifier.size(210.dp), contentAlignment = Alignment.Center) {
            if (percent != null) {
                ProgressRing(modifier = Modifier.fillMaxSize(), progress = percent / 100f)
            }
            VanessaOrb(
                size = 118.dp,
                energy = 0.62f,
                offline = false,
                ringCount = 3,
                description = null,
            )
        }

        Spacer(Modifier.height(10.dp))
        Text(
            text = phase.stateLabel,
            color = VanessaPalette.TextPrimary,
            style = VanessaType.heading,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(6.dp))
        Text(
            text = phase.summary,
            color = VanessaPalette.TextSecondary,
            style = VanessaType.bodySmall,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(8.dp))
        Text(
            text = if (percent != null) {
                "The PC reports $percent% complete."
            } else {
                "The PC has not reported a percentage, so none is shown."
            },
            color = VanessaPalette.TextDim,
            style = VanessaType.caption,
            textAlign = TextAlign.Center,
        )

        if (phase.steps.isNotEmpty()) {
            Spacer(Modifier.height(22.dp))
            Column(
                modifier = Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text("WHAT HAS HAPPENED", color = VanessaPalette.TextDim, style = VanessaType.eyebrow)
                phase.steps.forEachIndexed { index, step ->
                    StepRow(step = step, isCurrent = index == phase.steps.lastIndex)
                }
            }
        }

        Spacer(Modifier.height(18.dp))
        EnergyWave(
            modifier = Modifier
                .fillMaxWidth()
                .height(54.dp),
            intensity = 0.85f,
        )

        Spacer(Modifier.height(20.dp))
        if (canStop) {
            NeonSecondaryButton(
                text = if (phase.cancellationRequested) "Requesting cancellation…" else "Stop this task",
                onClick = onStop,
                modifier = Modifier.fillMaxWidth(),
                enabled = !phase.cancellationRequested && phase.cancellationAck == null,
            )
            Spacer(Modifier.height(10.dp))
        }

        val cancellationMessage = phase.cancellationAck?.message ?: phase.cancellationError
            ?: if (phase.cancellationRequested) {
                "Cancellation has been sent. Waiting for the PC to acknowledge it; the task is not marked stopped yet."
            } else null
        if (cancellationMessage != null) {
            Text(
                text = cancellationMessage,
                color = if (phase.cancellationError != null) VanessaPalette.Warning else VanessaPalette.TextSecondary,
                style = VanessaType.caption,
                textAlign = TextAlign.Center,
            )
        }
    }
}

@Composable
private fun StepRow(step: String, isCurrent: Boolean) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(
            modifier = Modifier
                .size(7.dp)
                .background(
                    if (isCurrent) VanessaPalette.Cyan else VanessaPalette.Border,
                    CircleShape,
                ),
        )
        Text(
            text = step,
            color = if (isCurrent) VanessaPalette.TextPrimary else VanessaPalette.TextSecondary,
            style = VanessaType.bodySmall,
        )
    }
}
