package com.vanessa.mobile.ui.screens

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
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.vanessa.mobile.ui.components.NeonButton
import com.vanessa.mobile.ui.components.NeonSecondaryButton
import com.vanessa.mobile.ui.components.VanessaOrb
import com.vanessa.mobile.ui.state.OutcomeTone
import com.vanessa.mobile.ui.state.TaskOutcome
import com.vanessa.mobile.ui.state.VerificationStatus
import com.vanessa.mobile.ui.theme.VanessaPalette
import com.vanessa.mobile.ui.theme.VanessaType

/**
 * The end of a task, told with the PC's own words and the PC's own verdict.
 *
 * Five tones, not two. "Succeeded and verified" is a different claim from
 * "succeeded, nothing was checked", and both are different from "partly done".
 * A green tick on an unverified result would be the single most misleading thing
 * this app could do, so the orb's check only appears on a verified success.
 */
@Composable
internal fun TaskResultScreen(
    outcome: TaskOutcome,
    onDone: () -> Unit,
    onRetry: (() -> Unit)? = null,
) {
    val accent = when (outcome.tone) {
        OutcomeTone.SUCCESS -> VanessaPalette.Lime
        OutcomeTone.PARTIAL -> VanessaPalette.Cyan
        OutcomeTone.UNVERIFIED -> VanessaPalette.Warning
        OutcomeTone.FAILURE -> VanessaPalette.Error
        OutcomeTone.UNKNOWN -> VanessaPalette.TextSecondary
    }

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
        Spacer(Modifier.height(6.dp))
        Text(eyebrow(outcome.tone), color = accent, style = VanessaType.eyebrow)
        Spacer(Modifier.height(16.dp))

        Box(modifier = Modifier.size(190.dp), contentAlignment = Alignment.Center) {
            VanessaOrb(
                size = 170.dp,
                energy = if (outcome.tone == OutcomeTone.SUCCESS) 0.55f else 0.22f,
                offline = false,
                ringCount = 3,
                showCheck = outcome.tone == OutcomeTone.SUCCESS,
                description = null,
            )
        }

        Spacer(Modifier.height(16.dp))
        Text(
            text = headline(outcome.tone),
            color = VanessaPalette.TextPrimary,
            style = VanessaType.headingLarge,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(8.dp))
        Text(
            text = outcome.safeSummary,
            color = VanessaPalette.TextSecondary,
            style = VanessaType.body,
            textAlign = TextAlign.Center,
        )

        Spacer(Modifier.height(18.dp))
        Column(
            modifier = Modifier.fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text("VERIFICATION", color = VanessaPalette.TextDim, style = VanessaType.eyebrow)
            Text(
                text = verificationLine(outcome),
                color = accent,
                style = VanessaType.bodySmall,
            )
            if (outcome.verificationSummary.isNotBlank()) {
                Text(
                    text = outcome.verificationSummary,
                    color = VanessaPalette.TextSecondary,
                    style = VanessaType.caption,
                )
            }
        }

        Spacer(Modifier.height(26.dp))
        NeonButton(
            text = if (outcome.tone == OutcomeTone.SUCCESS) "Great!" else "Back to Vanessa",
            onClick = onDone,
            modifier = Modifier.fillMaxWidth(),
        )
        if (outcome.tone == OutcomeTone.FAILURE && onRetry != null) {
            Spacer(Modifier.height(10.dp))
            NeonSecondaryButton(
                text = "Try again",
                onClick = onRetry,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

private fun eyebrow(tone: OutcomeTone): String = when (tone) {
    OutcomeTone.SUCCESS -> "COMPLETED"
    OutcomeTone.PARTIAL -> "PARTLY COMPLETED"
    OutcomeTone.UNVERIFIED -> "COMPLETED, NOT VERIFIED"
    OutcomeTone.FAILURE -> "NOT COMPLETED"
    OutcomeTone.UNKNOWN -> "RESULT UNKNOWN"
}

private fun headline(tone: OutcomeTone): String = when (tone) {
    OutcomeTone.SUCCESS -> "All set!"
    OutcomeTone.PARTIAL -> "Mostly done"
    OutcomeTone.UNVERIFIED -> "Finished, but unchecked"
    OutcomeTone.FAILURE -> "It didn't finish"
    OutcomeTone.UNKNOWN -> "No clear result"
}

private fun verificationLine(outcome: TaskOutcome): String = when (outcome.verification) {
    VerificationStatus.VERIFIED -> "The PC checked this result and confirmed it."
    VerificationStatus.PARTIAL -> "The PC could only partly confirm this result."
    VerificationStatus.NOT_AVAILABLE -> "The PC did not check this result, so treat it as unconfirmed."
    VerificationStatus.FAILED -> "The PC's verification of this result failed."
    VerificationStatus.UNKNOWN -> "No verification was reported for this result."
}

/**
 * A protocol error or a lost connection — deliberately *not* a [TaskOutcome].
 *
 * "The PC reported that the task failed" and "we never heard back from the PC"
 * are different facts, and the second one must never be rendered as the first.
 * This screen says only what is known, and offers a retry when the PC said the
 * error was retryable.
 */
@Composable
internal fun TaskErrorScreen(
    message: String,
    retryable: Boolean,
    onBack: () -> Unit,
    onRetry: (() -> Unit)? = null,
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
        Text("NO RESULT", color = VanessaPalette.Error, style = VanessaType.eyebrow)
        Spacer(Modifier.height(18.dp))
        Box(modifier = Modifier.size(150.dp), contentAlignment = Alignment.Center) {
            VanessaOrb(size = 138.dp, energy = 0.12f, offline = true, ringCount = 2, description = null)
        }
        Spacer(Modifier.height(18.dp))
        Text(
            text = "That didn't go through",
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
        Spacer(Modifier.height(10.dp))
        Text(
            text = if (retryable) {
                "The PC said this can be retried."
            } else {
                "This is not a task result — no outcome was reported."
            },
            color = VanessaPalette.TextDim,
            style = VanessaType.caption,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(24.dp))
        if (retryable && onRetry != null) {
            NeonButton(text = "Try again", onClick = onRetry, modifier = Modifier.fillMaxWidth())
            Spacer(Modifier.height(10.dp))
        }
        NeonSecondaryButton(text = "Back", onClick = onBack, modifier = Modifier.fillMaxWidth())
    }
}
