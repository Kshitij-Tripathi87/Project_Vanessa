package com.vanessa.mobile.ui.components

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import com.vanessa.mobile.ui.theme.VanessaGradients
import com.vanessa.mobile.ui.theme.VanessaMotionSpec
import com.vanessa.mobile.ui.theme.VanessaPalette
import com.vanessa.mobile.ui.theme.VanessaRadius
import com.vanessa.mobile.ui.theme.VanessaType

/**
 * The primary action: a blue → cyan → lime pill with dark lettering.
 *
 * There is exactly one of these per screen. The sweep is the loudest thing in
 * the design, so a screen with two of them has no primary action at all — the
 * secondary and the plain control below exist for that reason.
 */
@Composable
internal fun NeonButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    leadingIcon: ImageVector? = null,
    trailingIcon: ImageVector? = null,
    height: androidx.compose.ui.unit.Dp = 56.dp,
) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val scale by animateFloatAsState(
        targetValue = if (pressed) 0.975f else 1f,
        animationSpec = tween(VanessaMotionSpec.pressMillis),
        label = "primary-press",
    )
    val contentColor = if (enabled) VanessaPalette.OnGradient else VanessaPalette.TextDim

    Box(
        modifier = modifier
            .height(height)
            .graphicsLayer { scaleX = scale; scaleY = scale }
            .clip(RoundedCornerShape(VanessaRadius.chip))
            .background(
                if (enabled) {
                    VanessaGradients.primarySweepBrush
                } else {
                    androidx.compose.ui.graphics.Brush.horizontalGradient(
                        listOf(VanessaPalette.SurfaceStrong, VanessaPalette.SurfaceStrong),
                    )
                },
            )
            .clickable(
                interactionSource = interaction,
                indication = null,
                enabled = enabled,
                role = Role.Button,
                onClick = onClick,
            )
            .padding(horizontal = 22.dp),
        contentAlignment = Alignment.Center,
    ) {
        CompositionLocalProvider(LocalContentColor provides contentColor) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                if (leadingIcon != null) {
                    Icon(leadingIcon, contentDescription = null, modifier = Modifier.size(18.dp))
                }
                Text(text = text, color = contentColor, style = VanessaType.button)
                if (trailingIcon != null) {
                    Icon(trailingIcon, contentDescription = null, modifier = Modifier.size(18.dp))
                }
            }
        }
    }
}

/**
 * The secondary action: dark fill, blue-grey hairline, light lettering.
 *
 * Deliberately quieter than [NeonButton] and never gradient-filled — used for
 * "Skip", "Cancel" and "Type instead", so the destructive or deferring choice
 * is never the most visually attractive one.
 */
@Composable
internal fun NeonSecondaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    leadingIcon: ImageVector? = null,
    height: androidx.compose.ui.unit.Dp = 52.dp,
) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val scale by animateFloatAsState(
        targetValue = if (pressed) 0.975f else 1f,
        animationSpec = tween(VanessaMotionSpec.pressMillis),
        label = "secondary-press",
    )

    Box(
        modifier = modifier
            .height(height)
            .graphicsLayer { scaleX = scale; scaleY = scale }
            .clip(RoundedCornerShape(VanessaRadius.chip))
            .background(VanessaGradients.secondaryFill)
            .border(
                BorderStroke(1.dp, if (enabled) VanessaPalette.Border else Color.Transparent),
                RoundedCornerShape(VanessaRadius.chip),
            )
            .clickable(
                interactionSource = interaction,
                indication = null,
                enabled = enabled,
                role = Role.Button,
                onClick = onClick,
            )
            .padding(horizontal = 22.dp),
        contentAlignment = Alignment.Center,
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (leadingIcon != null) {
                Icon(
                    leadingIcon,
                    contentDescription = null,
                    modifier = Modifier.size(18.dp),
                    tint = VanessaPalette.TextSecondary,
                )
            }
            Text(
                text = text,
                color = if (enabled) VanessaPalette.TextPrimary else VanessaPalette.TextDim,
                style = VanessaType.button,
            )
        }
    }
}

/**
 * A circular icon control with a thin blue ring — the mic, the close button and
 * the back arrow. [highlighted] fills the ring and lifts the glow; used to show
 * that the control is currently doing something (listening, for example).
 */
@Composable
internal fun NeonIconButton(
    icon: ImageVector,
    contentDescription: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    diameter: androidx.compose.ui.unit.Dp = 56.dp,
    highlighted: Boolean = false,
    enabled: Boolean = true,
) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val scale by animateFloatAsState(
        targetValue = if (pressed) 0.94f else 1f,
        animationSpec = tween(VanessaMotionSpec.pressMillis),
        label = "icon-press",
    )
    val ringColor = when {
        !enabled -> VanessaPalette.Border
        highlighted -> VanessaPalette.Cyan
        else -> VanessaPalette.Brand.copy(alpha = 0.55f)
    }

    Box(
        modifier = modifier
            .size(diameter)
            .graphicsLayer { scaleX = scale; scaleY = scale }
            .clip(CircleShape)
            .background(
                if (highlighted) VanessaPalette.Card.copy(alpha = 0.92f) else VanessaPalette.CardDeep,
            )
            .border(BorderStroke(1.dp, ringColor), CircleShape)
            .clickable(
                interactionSource = interaction,
                indication = null,
                enabled = enabled,
                role = Role.Button,
                onClick = onClick,
            ),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            imageVector = icon,
            contentDescription = contentDescription,
            tint = when {
                !enabled -> VanessaPalette.TextDim
                highlighted -> VanessaPalette.Cyan
                else -> VanessaPalette.TextPrimary
            },
            modifier = Modifier.size(if (highlighted) 24.dp else 22.dp),
        )
    }
}
