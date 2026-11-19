package com.vanessa.mobile.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable

/**
 * The app theme.
 *
 * Only a dark scheme exists. There is no light variant to fall back to: the
 * identity is a black environment with lit objects in it, and a light theme
 * would not be a recolouring of that design, it would be a different one.
 */
@Composable
internal fun VanessaTheme(content: @Composable () -> Unit) {
    val palette = VanessaPalette
    MaterialTheme(
        colorScheme = darkColorScheme(
            primary = palette.Brand,
            onPrimary = palette.OnGradient,
            secondary = palette.Cyan,
            onSecondary = palette.OnGradient,
            tertiary = palette.Lime,
            background = palette.Background,
            onBackground = palette.TextPrimary,
            surface = palette.Surface,
            onSurface = palette.TextPrimary,
            surfaceVariant = palette.SurfaceStrong,
            onSurfaceVariant = palette.TextSecondary,
            outline = palette.Border,
            error = palette.Error,
            onError = palette.TextPrimary,
        ),
        typography = vanessaTypography(),
        content = content,
    )
}
