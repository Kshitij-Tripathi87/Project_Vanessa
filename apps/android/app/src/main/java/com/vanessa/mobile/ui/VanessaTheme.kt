package com.vanessa.mobile.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.Typography
import androidx.compose.runtime.Composable
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

@Composable
internal fun VanessaTheme(content: @Composable () -> Unit) {
    val palette = VanessaPalette
    MaterialTheme(
        colorScheme = darkColorScheme(
            primary = palette.Brand,
            onPrimary = palette.TextPrimary,
            background = palette.Background,
            onBackground = palette.TextPrimary,
            surface = palette.Surface,
            onSurface = palette.TextPrimary,
            surfaceVariant = palette.SurfaceStrong,
            onSurfaceVariant = palette.TextSecondary,
            outline = palette.Border,
            error = palette.Error,
        ),
        typography = Typography(
            displayLarge = TextStyle(
                fontFamily = FontFamily.SansSerif,
                fontSize = 32.sp,
                lineHeight = 40.sp,
                fontWeight = FontWeight.SemiBold,
                letterSpacing = (-0.7).sp,
            ),
            headlineMedium = TextStyle(
                fontFamily = FontFamily.SansSerif,
                fontSize = 24.sp,
                lineHeight = 32.sp,
                fontWeight = FontWeight.SemiBold,
                letterSpacing = (-0.4).sp,
            ),
            titleLarge = TextStyle(
                fontFamily = FontFamily.SansSerif,
                fontSize = 20.sp,
                lineHeight = 28.sp,
                fontWeight = FontWeight.SemiBold,
            ),
            bodyLarge = TextStyle(
                fontFamily = FontFamily.SansSerif,
                fontSize = 16.sp,
                lineHeight = 24.sp,
            ),
            bodyMedium = TextStyle(
                fontFamily = FontFamily.SansSerif,
                fontSize = 14.sp,
                lineHeight = 20.sp,
            ),
            labelLarge = TextStyle(
                fontFamily = FontFamily.SansSerif,
                fontSize = 14.sp,
                lineHeight = 20.sp,
                fontWeight = FontWeight.Medium,
            ),
            labelSmall = TextStyle(
                fontFamily = FontFamily.SansSerif,
                fontSize = 12.sp,
                lineHeight = 16.sp,
                color = palette.TextSecondary,
            ),
        ),
        content = content,
    )
}
