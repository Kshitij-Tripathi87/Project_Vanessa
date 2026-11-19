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
import androidx.compose.material.icons.outlined.ArrowBack
import androidx.compose.material.icons.outlined.ArrowForward
import androidx.compose.material.icons.outlined.Bolt
import androidx.compose.material.icons.outlined.DateRange
import androidx.compose.material.icons.outlined.ChevronLeft
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material.icons.outlined.Shield
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.time.LocalTime
import com.vanessa.mobile.ui.components.EnergyWave
import com.vanessa.mobile.ui.components.LightBeam
import com.vanessa.mobile.ui.components.NeonButton
import com.vanessa.mobile.ui.components.VanessaOrb
import com.vanessa.mobile.ui.theme.VanessaPalette

/**
 * Screens 1–3 of the reconstruction brief: Welcome, Onboarding, Permissions.
 *
 * The visual language follows the specification; the *content* is Vanessa's
 * real first run. That distinction matters on the permissions screen: the
 * brief lists Microphone / File Access / Notifications / Location, but this
 * build only ever asks for the microphone and the calendar. Requesting or
 * implying notification and location access would be a claim the app cannot
 * honour, so those rows are not drawn — the footnote says so explicitly.
 */

@Composable
internal fun GlowPillButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    leadingIcon: ImageVector? = null,
    trailingIcon: ImageVector? = null,
) {
    // The gradient sweep now lives in one component. Screens keep calling this
    // name until they are migrated one by one, so a restyle never lands as a
    // rename sweep in the same change as a behaviour change.
    NeonButton(
        text = text,
        onClick = onClick,
        modifier = modifier,
        enabled = enabled,
        leadingIcon = leadingIcon,
        trailingIcon = trailingIcon,
    )
}

@Composable
private fun GradientIndicator(modifier: Modifier = Modifier) {
    Box(
        modifier
            .width(46.dp)
            .height(3.dp)
            .clip(RoundedCornerShape(2.dp))
            .background(
                Brush.horizontalGradient(
                    listOf(VanessaPalette.Brand, VanessaPalette.Cyan, VanessaPalette.Lime),
                ),
            ),
    )
}

private fun greetingForNow(): String {
    // Deliberately local time only: the reference's "Good evening" must be
    // true when it is shown.
    val hour = runCatching { LocalTime.now().hour }.getOrDefault(19)
    return when (hour) {
        in 5..11 -> "Good morning"
        in 12..16 -> "Good afternoon"
        in 17..21 -> "Good evening"
        else -> "Working late"
    }
}

@Composable
internal fun WelcomeScreen(
    inset: Dp,
    onStart: () -> Unit,
) {
    Box(modifier = Modifier.fillMaxSize()) {
        LightBeam(
            modifier = Modifier
                .align(Alignment.TopCenter)
                .fillMaxWidth(0.6f)
                .height(320.dp),
        )
        EnergyWave(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .height(280.dp)
                .padding(bottom = 34.dp),
            intensity = 0.85f,
        )

        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = inset)
                .padding(top = 36.dp, bottom = 30.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Spacer(Modifier.height(18.dp))
            VanessaOrb(
                size = 206.dp,
                energy = 0.4f,
                offline = false,
                description = "Vanessa orb",
            )
            Spacer(Modifier.height(20.dp))
            Text(
                text = "Vanessa",
                color = VanessaPalette.TextPrimary,
                fontSize = 38.sp,
                fontWeight = FontWeight.Light,
                letterSpacing = 0.6.sp,
            )
            Spacer(Modifier.height(6.dp))
            Text(
                text = greetingForNow(),
                color = VanessaPalette.TextSecondary,
                fontSize = 16.sp,
            )
            Spacer(Modifier.height(14.dp))
            GradientIndicator()
            Spacer(Modifier.weight(1f))
            GlowPillButton(
                text = "Get Started",
                onClick = onStart,
                modifier = Modifier.fillMaxWidth(),
                leadingIcon = Icons.Outlined.ChevronLeft,
                trailingIcon = Icons.Outlined.ArrowForward,
            )
        }
    }
}

@Composable
internal fun OnboardingScreen(
    inset: Dp,
    onBack: () -> Unit,
    onSkip: () -> Unit,
    onContinue: () -> Unit,
) {
    Box(modifier = Modifier.fillMaxSize()) {
        EnergyWave(
            modifier = Modifier
                .align(Alignment.TopCenter)
                .fillMaxWidth()
                .height(230.dp)
                .offset(y = 150.dp),
            intensity = 0.62f,
        )

        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = inset)
                .padding(top = 8.dp, bottom = 28.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = onBack, modifier = Modifier.size(44.dp)) {
                    Icon(
                        Icons.Outlined.ArrowBack,
                        contentDescription = "Back to welcome",
                        tint = VanessaPalette.TextPrimary,
                    )
                }
                Spacer(Modifier.weight(1f))
                TextButton(onClick = onSkip) {
                    Text("Skip", color = VanessaPalette.TextSecondary, fontSize = 14.sp)
                }
            }

            Spacer(Modifier.height(4.dp))
            Text(
                text = "Your Personal\nAI Assistant",
                color = VanessaPalette.TextPrimary,
                fontSize = 22.sp,
                lineHeight = 28.sp,
                fontWeight = FontWeight.Medium,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(8.dp))
            Text(
                text = "Talk. Plan. Get it done.",
                color = VanessaPalette.TextSecondary,
                fontSize = 13.sp,
                textAlign = TextAlign.Center,
            )

            Spacer(Modifier.height(10.dp))
            VanessaOrb(
                size = 100.dp,
                energy = 0.2f,
                offline = false,
                ringCount = 2,
                description = null,
            )

            Spacer(Modifier.height(18.dp))
            Column(
                modifier = Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                FeatureCard(
                    icon = Icons.Outlined.Mic,
                    title = "Voice-first interaction",
                    subtitle = "Just speak naturally",
                )
                FeatureCard(
                    icon = Icons.Outlined.Bolt,
                    title = "Smart automation",
                    subtitle = "Let Vanessa handle it",
                )
                FeatureCard(
                    icon = Icons.Outlined.Shield,
                    title = "Your privacy, always",
                    subtitle = "On-device & secure",
                )
            }

            Spacer(Modifier.height(18.dp))
            ProgressDots(total = 4, active = 0)
            Spacer(Modifier.height(20.dp))
            GlowPillButton(
                text = "Continue",
                onClick = onContinue,
                modifier = Modifier.fillMaxWidth(),
                trailingIcon = Icons.Outlined.ArrowForward,
            )
        }
    }
}

@Composable
private fun FeatureCard(icon: ImageVector, title: String, subtitle: String) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = VanessaPalette.Surface.copy(alpha = 0.82f),
        shape = RoundedCornerShape(18.dp),
        border = androidx.compose.foundation.BorderStroke(1.dp, VanessaPalette.Border),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 13.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier
                    .size(38.dp)
                    .clip(RoundedCornerShape(12.dp))
                    .background(VanessaPalette.Brand.copy(alpha = 0.14f)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(icon, contentDescription = null, tint = VanessaPalette.Cyan, modifier = Modifier.size(20.dp))
            }
            Spacer(Modifier.width(12.dp))
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(title, color = VanessaPalette.TextPrimary, fontSize = 14.sp, fontWeight = FontWeight.Medium)
                Text(subtitle, color = VanessaPalette.TextSecondary, fontSize = 12.sp)
            }
        }
    }
}

@Composable
private fun ProgressDots(total: Int, active: Int) {
    Row(horizontalArrangement = Arrangement.spacedBy(7.dp), verticalAlignment = Alignment.CenterVertically) {
        repeat(total) { index ->
            val selected = index == active
            Box(
                modifier = Modifier
                    .height(4.dp)
                    .width(if (selected) 20.dp else 8.dp)
                    .clip(RoundedCornerShape(2.dp))
                    .background(
                        if (selected) VanessaPalette.Cyan else VanessaPalette.TextSecondary.copy(alpha = 0.28f),
                    ),
            )
        }
    }
}

@Composable
internal fun PermissionsScreen(
    inset: Dp,
    microphoneGranted: Boolean,
    calendarGranted: Boolean,
    onBack: () -> Unit,
    onRequestAll: () -> Unit,
    onFinish: () -> Unit,
) {
    val allGranted = microphoneGranted && calendarGranted

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = inset)
            .padding(top = 8.dp, bottom = 28.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack, modifier = Modifier.size(44.dp)) {
                Icon(
                    Icons.Outlined.ArrowBack,
                    contentDescription = "Back to introduction",
                    tint = VanessaPalette.TextPrimary,
                )
            }
            Spacer(Modifier.weight(1f))
        }

        Text(
            text = "Allow Permissions",
            color = VanessaPalette.TextPrimary,
            fontSize = 21.sp,
            fontWeight = FontWeight.Medium,
        )
        Spacer(Modifier.height(8.dp))
        Text(
            text = "To provide the best experience, Vanessa needs a few permissions.",
            color = VanessaPalette.TextSecondary,
            fontSize = 13.sp,
            lineHeight = 19.sp,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(horizontal = 18.dp),
        )

        Spacer(Modifier.height(12.dp))
        Box(modifier = Modifier.size(228.dp), contentAlignment = Alignment.Center) {
            VanessaOrb(size = 132.dp, energy = 0.3f, offline = false, description = null)
            PermissionBubble(
                icon = Icons.Outlined.Mic,
                description = if (microphoneGranted) "Microphone granted" else "Microphone not granted",
                granted = microphoneGranted,
                modifier = Modifier.align(Alignment.TopStart).offset(x = 6.dp, y = 26.dp),
            )
            PermissionBubble(
                icon = Icons.Outlined.Folder,
                description = "Files are shared one at a time",
                granted = false,
                modifier = Modifier.align(Alignment.TopEnd).offset(x = (-6).dp, y = 16.dp),
            )
            PermissionBubble(
                icon = Icons.Outlined.DateRange,
                description = if (calendarGranted) "Calendar granted" else "Calendar not granted",
                granted = calendarGranted,
                modifier = Modifier.align(Alignment.BottomStart).offset(x = 12.dp, y = (-18).dp),
            )
            PermissionBubble(
                icon = Icons.Outlined.Shield,
                description = "On-device processing",
                granted = true,
                modifier = Modifier.align(Alignment.BottomEnd).offset(x = (-12).dp, y = (-28).dp),
            )
        }
        Spacer(Modifier.height(10.dp))

        Surface(
            modifier = Modifier.fillMaxWidth(),
            color = VanessaPalette.Surface.copy(alpha = 0.9f),
            shape = RoundedCornerShape(20.dp),
            border = androidx.compose.foundation.BorderStroke(1.dp, VanessaPalette.Border),
        ) {
            Column(modifier = Modifier.padding(horizontal = 14.dp, vertical = 6.dp)) {
                PermissionRow(
                    icon = Icons.Outlined.Mic,
                    title = "Microphone",
                    subtitle = "For voice interaction",
                    state = if (microphoneGranted) "Granted" else "Not granted",
                    granted = microphoneGranted,
                )
                HorizontalHairline()
                PermissionRow(
                    icon = Icons.Outlined.Folder,
                    title = "File access",
                    subtitle = "Chosen per file, never blanket",
                    state = "On request",
                    granted = false,
                )
                HorizontalHairline()
                PermissionRow(
                    icon = Icons.Outlined.DateRange,
                    title = "Calendar",
                    subtitle = "Only when a request needs it",
                    state = if (calendarGranted) "Granted" else "Not granted",
                    granted = calendarGranted,
                )
            }
        }

        Spacer(Modifier.height(12.dp))
        Text(
            text = "Vanessa does not ask for notification or location access, because it does not use them.",
            color = VanessaPalette.TextDim,
            fontSize = 11.sp,
            lineHeight = 16.sp,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(horizontal = 10.dp),
        )

        Spacer(Modifier.height(20.dp))
        GlowPillButton(
            text = if (allGranted) "Continue" else "Allow All",
            onClick = { if (allGranted) onFinish() else onRequestAll() },
            modifier = Modifier.fillMaxWidth(),
        )
        TextButton(onClick = onFinish) {
            Text("Not now", color = VanessaPalette.TextSecondary, fontSize = 13.sp)
        }
    }
}

@Composable
private fun PermissionBubble(
    icon: ImageVector,
    description: String,
    granted: Boolean,
    modifier: Modifier = Modifier,
) {
    Box(
        modifier = modifier
            .size(40.dp)
            .clip(CircleShape)
            .background(VanessaPalette.SurfaceStrong.copy(alpha = 0.9f))
            .background(
                Brush.radialGradient(
                    listOf(
                        (if (granted) VanessaPalette.Lime else VanessaPalette.Cyan).copy(alpha = 0.16f),
                        Color.Transparent,
                    ),
                ),
            ),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            icon,
            contentDescription = description,
            tint = if (granted) VanessaPalette.Lime else VanessaPalette.TextSecondary,
            modifier = Modifier.size(18.dp),
        )
    }
}

@Composable
private fun PermissionRow(
    icon: ImageVector,
    title: String,
    subtitle: String,
    state: String,
    granted: Boolean,
) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            icon,
            contentDescription = null,
            tint = if (granted) VanessaPalette.Lime else VanessaPalette.Cyan,
            modifier = Modifier.size(20.dp),
        )
        Spacer(Modifier.width(12.dp))
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, color = VanessaPalette.TextPrimary, fontSize = 14.sp)
            Text(subtitle, color = VanessaPalette.TextSecondary, fontSize = 11.sp)
        }
        Text(state, color = if (granted) VanessaPalette.Lime else VanessaPalette.TextSecondary, fontSize = 11.sp)
        Spacer(Modifier.width(4.dp))
        Icon(
            Icons.Outlined.ChevronRight,
            contentDescription = null,
            tint = VanessaPalette.TextSecondary.copy(alpha = 0.6f),
            modifier = Modifier.size(16.dp),
        )
    }
}

@Composable
private fun HorizontalHairline() {
    Box(
        Modifier
            .fillMaxWidth()
            .height(1.dp)
            .background(VanessaPalette.Border.copy(alpha = 0.7f)),
    )
}

