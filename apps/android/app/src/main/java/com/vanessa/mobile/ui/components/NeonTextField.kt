package com.vanessa.mobile.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.material3.Text
import com.vanessa.mobile.ui.theme.VanessaPalette
import com.vanessa.mobile.ui.theme.VanessaType

/**
 * Branded Vanessa input surface. Uses BasicTextField so the visual treatment
 * is shared by chat, settings, and QR pairing rather than inherited from
 * Material outlined-field defaults.
 */
@Composable
internal fun NeonTextField(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    label: String? = null,
    placeholder: String = "",
    enabled: Boolean = true,
    singleLine: Boolean = true,
    maxLines: Int = if (singleLine) 1 else 6,
    minHeight: Dp = if (singleLine) 56.dp else 110.dp,
    containerColor: Color = VanessaPalette.CardDeep,
    outlineColor: Color = VanessaPalette.Border,
    shape: Shape = RoundedCornerShape(14.dp),
    horizontalPadding: Dp = 14.dp,
    verticalPadding: Dp = 12.dp,
) {
    var focused by remember { mutableStateOf(false) }
    Column(
        modifier = modifier,
        verticalArrangement = Arrangement.spacedBy(if (label.isNullOrBlank()) 0.dp else 6.dp),
    ) {
        if (!label.isNullOrBlank()) {
            Text(label, color = VanessaPalette.TextSecondary, style = VanessaType.caption)
        }
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            enabled = enabled,
            singleLine = singleLine,
            maxLines = maxLines,
            textStyle = VanessaType.body.copy(
                color = if (enabled) VanessaPalette.TextPrimary else VanessaPalette.TextDim,
            ),
            cursorBrush = SolidColor(VanessaPalette.Cyan),
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = minHeight)
                .onFocusChanged { focused = it.isFocused },
            decorationBox = { innerTextField ->
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = minHeight)
                        .clip(shape)
                        .background(containerColor)
                        .border(
                            width = 1.dp,
                            color = when {
                                !enabled -> outlineColor.copy(alpha = 0.45f)
                                focused -> VanessaPalette.Cyan
                                else -> outlineColor
                            },
                            shape = shape,
                        )
                        .padding(horizontal = horizontalPadding, vertical = verticalPadding),
                    contentAlignment = if (singleLine) Alignment.CenterStart else Alignment.TopStart,
                ) {
                    if (value.isEmpty() && placeholder.isNotBlank()) {
                        Text(placeholder, color = VanessaPalette.TextDim, style = VanessaType.bodySmall)
                    }
                    innerTextField()
                }
            },
        )
    }
}
