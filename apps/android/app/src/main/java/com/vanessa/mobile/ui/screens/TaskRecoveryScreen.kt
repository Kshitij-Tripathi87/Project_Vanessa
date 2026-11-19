package com.vanessa.mobile.ui.screens

import androidx.compose.foundation.background
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
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.vanessa.mobile.ui.components.EnergyWave
import com.vanessa.mobile.ui.components.NeonSecondaryButton
import com.vanessa.mobile.ui.components.VanessaOrb
import com.vanessa.mobile.ui.theme.VanessaPalette
import com.vanessa.mobile.ui.theme.VanessaType

/**
 * The reconnect gap, made visible.
 *
 * Two shapes, one screen. [working] is the honest "we are asking the PC what is
 * going on"; the other shape is the honest "the PC could not tell us".
 *
 * Neither shows the last-known task summary as if it were current. That is the
 * whole point of the screen: a stale "Executing…" left on display through a
 * disconnection is a fabricated status indicator, and this screen exists so the
 * app never has to choose between that and an empty page.
 */
@Composable
internal fun TaskRecoveryScreen(
    title: String,
    message: String,
    working: Boolean,
    onDismiss: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(VanessaPalette.Obsidian)
            .windowInsetsPadding(WindowInsets.safeDrawing)
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 22.dp)
            .padding(top = 14.dp, bottom = 28.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Spacer(Modifier.height(24.dp))
        Text(
            text = if (working) "RECONNECTING" else "STATE UNAVAILABLE",
            color = if (working) VanessaPalette.Cyan else VanessaPalette.Warning,
            style = VanessaType.eyebrow,
        )
        Spacer(Modifier.height(18.dp))

        Box(modifier = Modifier.size(160.dp), contentAlignment = Alignment.Center) {
            VanessaOrb(
                size = if (working) 150.dp else 138.dp,
                energy = if (working) 0.35f else 0.10f,
                offline = !working,
                ringCount = if (working) 3 else 2,
                description = null,
            )
        }

        Spacer(Modifier.height(18.dp))
        Text(
            text = title,
            color = VanessaPalette.TextPrimary,
            style = VanessaType.heading,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(8.dp))
        Text(
            text = message,
            color = VanessaPalette.TextSecondary,
            style = VanessaType.body,
            textAlign = TextAlign.Center,
        )

        if (working) {
            Spacer(Modifier.height(20.dp))
            EnergyWave(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(46.dp),
                intensity = 0.5f,
            )
        }

        Spacer(Modifier.height(24.dp))
        Text(
            text = if (working) {
                "Vanessa asks the PC for the task's real state. Nothing is shown until it answers."
            } else {
                "Vanessa will not guess what happened. Check the PC, or start a new request once you are reconnected."
            },
            color = VanessaPalette.TextDim,
            style = VanessaType.caption,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(22.dp))
        NeonSecondaryButton(
            text = if (working) "Back" else "Back to PC",
            onClick = onDismiss,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}
