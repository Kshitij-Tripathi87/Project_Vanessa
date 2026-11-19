package com.vanessa.mobile.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/**
 * The type scale from the reference board.
 *
 * Sizes are set in sp so the system font scale still applies — the board's
 * hierarchy is reproduced, but a user who enlarges text is never overruled by
 * a pixel-fixed layout. Weights are deliberately light: a display face at 38 sp
 * with normal weight reads as an identity mark, where semibold at that size
 * reads as a headline shouting.
 *
 * The board asks for Inter / SF Pro Display / Manrope / Google Sans. None is
 * bundled: shipping a font file means owning its licence and its download, and
 * a downloadable font would silently fall back to Roboto on a device without
 * network. The platform sans is used instead, with metrics tuned to match the
 * board's line heights. See the README's deviation note.
 */
internal object VanessaType {
    private val sans = FontFamily.SansSerif

    /** "Vanessa" on the splash and the welcome mark. */
    val splash = TextStyle(
        fontFamily = sans,
        fontSize = 38.sp,
        lineHeight = 44.sp,
        fontWeight = FontWeight.Light,
        letterSpacing = 0.4.sp,
    )

    /** Screen headings — "All set!", "Executing Task…", "Allow Permissions". */
    val heading = TextStyle(
        fontFamily = sans,
        fontSize = 22.sp,
        lineHeight = 30.sp,
        fontWeight = FontWeight.Normal,
        letterSpacing = (-0.2).sp,
    )

    /** Larger heading used where a screen has one dominant line. */
    val headingLarge = TextStyle(
        fontFamily = sans,
        fontSize = 26.sp,
        lineHeight = 34.sp,
        fontWeight = FontWeight.Light,
        letterSpacing = (-0.4).sp,
    )

    /** All-caps section label above content. */
    val eyebrow = TextStyle(
        fontFamily = sans,
        fontSize = 10.sp,
        lineHeight = 14.sp,
        fontWeight = FontWeight.Medium,
        letterSpacing = 1.6.sp,
    )

    val body = TextStyle(
        fontFamily = sans,
        fontSize = 14.sp,
        lineHeight = 21.sp,
        fontWeight = FontWeight.Normal,
    )

    val bodySmall = TextStyle(
        fontFamily = sans,
        fontSize = 13.sp,
        lineHeight = 20.sp,
        fontWeight = FontWeight.Normal,
    )

    /** Card and row titles. */
    val cardTitle = TextStyle(
        fontFamily = sans,
        fontSize = 13.sp,
        lineHeight = 18.sp,
        fontWeight = FontWeight.Medium,
        letterSpacing = 0.1.sp,
    )

    /** Secondary line under a card title. */
    val cardSubtitle = TextStyle(
        fontFamily = sans,
        fontSize = 12.sp,
        lineHeight = 17.sp,
        fontWeight = FontWeight.Normal,
    )

    /** Button and control labels. */
    val button = TextStyle(
        fontFamily = sans,
        fontSize = 14.sp,
        lineHeight = 18.sp,
        fontWeight = FontWeight.SemiBold,
        letterSpacing = 0.2.sp,
    )

    /** Numeric readouts (percentages the backend actually reported). */
    val metric = TextStyle(
        fontFamily = sans,
        fontSize = 24.sp,
        lineHeight = 28.sp,
        fontWeight = FontWeight.Light,
        letterSpacing = (-0.6).sp,
    )

    val caption = TextStyle(
        fontFamily = sans,
        fontSize = 11.sp,
        lineHeight = 16.sp,
        fontWeight = FontWeight.Normal,
        letterSpacing = 0.1.sp,
    )
}

/** Material's slots, mapped onto the scale above so Material defaults inherit it. */
internal fun vanessaTypography(): Typography = Typography(
    displayLarge = VanessaType.splash,
    displayMedium = VanessaType.headingLarge,
    headlineLarge = VanessaType.headingLarge,
    headlineMedium = VanessaType.heading,
    headlineSmall = VanessaType.heading,
    titleLarge = VanessaType.heading,
    titleMedium = VanessaType.cardTitle,
    titleSmall = VanessaType.cardTitle,
    bodyLarge = VanessaType.body,
    bodyMedium = VanessaType.body,
    bodySmall = VanessaType.bodySmall,
    labelLarge = VanessaType.button,
    labelMedium = VanessaType.cardTitle,
    labelSmall = VanessaType.caption,
)
