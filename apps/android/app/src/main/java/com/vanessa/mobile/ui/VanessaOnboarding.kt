package com.vanessa.mobile.ui

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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
internal fun OnboardingScreen(
    step: Int,
    onNext: () -> Unit,
    onSkip: () -> Unit,
) {
    val title = when (step) {
        0 -> "An assistant that moves with you"
        1 -> "Speak or type. Switch anytime."
        else -> "Your devices stay yours."
    }
    val body = when (step) {
        0 -> "One place to think, plan, and get things done across your phone and PC."
        1 -> "Use voice when it suits you. Use chat when you want a quieter, more precise interaction."
        else -> "Import a local model and pair a Windows PC when you're ready. Vanessa keeps protected actions behind your approval."
    }

    Column(
        modifier = Modifier.fillMaxSize()
            .windowInsetsPadding(WindowInsets.safeDrawing)
            .background(VanessaPalette.Background)
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 26.dp, vertical = 18.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(18.dp),
    ) {
        Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(
                "VANESSA",
                modifier = Modifier.weight(1f),
                color = VanessaPalette.TextSecondary,
                fontSize = 11.sp,
                letterSpacing = 2.sp,
                fontWeight = FontWeight.SemiBold,
            )
            TextButton(onClick = onSkip) {
                Text("Skip", color = VanessaPalette.TextSecondary)
            }
        }

        Spacer(Modifier.height(20.dp))
        VanessaOrb(156.dp, active = false, offline = false)
        Text(
            title,
            color = VanessaPalette.TextPrimary,
            style = MaterialTheme.typography.headlineMedium,
            textAlign = TextAlign.Center,
        )
        Text(
            body,
            modifier = Modifier.fillMaxWidth(0.88f),
            color = VanessaPalette.TextSecondary,
            style = MaterialTheme.typography.bodyLarge,
            textAlign = TextAlign.Center,
        )

        Row(modifier = Modifier.padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(7.dp)) {
            repeat(3) { index ->
                Box(
                    modifier = Modifier.size(width = 24.dp, height = 4.dp)
                        .clip(CircleShape)
                        .background(if (index == step) VanessaPalette.Brand else VanessaPalette.SurfaceStrong),
                )
            }
        }

        Spacer(Modifier.height(8.dp))
        Button(
            onClick = onNext,
            modifier = Modifier.fillMaxWidth().height(54.dp),
            shape = RoundedCornerShape(16.dp),
            colors = ButtonDefaults.buttonColors(
                containerColor = VanessaPalette.Brand,
                contentColor = VanessaPalette.TextPrimary,
            ),
        ) {
            Text(if (step < 2) "Continue" else "Enter Vanessa")
        }
    }
}
