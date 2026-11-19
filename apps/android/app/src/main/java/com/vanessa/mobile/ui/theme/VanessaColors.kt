package com.vanessa.mobile.ui.theme

import androidx.compose.foundation.background
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color

/**
 * The single source of colour in the app.
 *
 * These are the reference board's tokens: a near-black environment
 * ([Obsidian]), one navy used for depth ([Navy]), electric blue ([Brand]),
 * cyan ([Cyan]) and a lime accent that is only ever used for warmth on the
 * orb's lower edge, a completion state, or the end of a primary gradient.
 *
 * Nothing here is a pastel, a purple or an orange, and no screen paints a
 * global gradient wash — a wash would flatten the black environment the whole
 * identity depends on.
 */
internal object VanessaPalette {
    /** Page background. The environment is black; it is not "dark grey". */
    val Obsidian = Color(0xFF03050A)

    /** The one navy used to give black a sense of depth. */
    val Navy = Color(0xFF080F22)

    /** Raised card surface. */
    val Card = Color(0xFF151C2D)

    /** Recessed surface, used inside cards. */
    val CardDeep = Color(0xFF101728)

    /** Electric blue: primary action, primary light. */
    val Brand = Color(0xFF0755FF)

    /** Lighter cobalt for the start of gradients and for rims. */
    val BlueSoft = Color(0xFF2E6BFF)

    /** Cyan: secondary light, specular highlights, live indicators. */
    val Cyan = Color(0xFF35A5FF)

    /** Lime: completion, warmth on the orb, the far end of the CTA sweep. */
    val Lime = Color(0xFFA8F443)

    /** Muted lime for hairlines and low-emphasis confirmation. */
    val LimeDim = Color(0xFF6E9E33)

    /** Low-contrast card border. Never a bright outline. */
    val Border = Color(0xFF1E2A44)

    val Background = Obsidian
    val Surface = Card
    val SurfaceStrong = CardDeep

    val TextPrimary = Color(0xFFFFFFFF)
    val TextSecondary = Color(0xFFB9C5DA)
    val TextDim = Color(0xFF7C879B)

    val Success = Lime
    val Error = Color(0xFFEF4444)
    val Warning = Color(0xFFFFB020)

    /** Deep lettering used on top of the blue→lime sweep. */
    val OnGradient = Color(0xFF04101C)
}

/**
 * Reusable brushes.
 *
 * Kept as functions rather than top-level `val`s because a `Brush` is
 * resolved against a canvas at draw time, and the primary sweep has to follow
 * the width of whatever it fills.
 */
internal object VanessaGradients {
    /** Blue → cyan → lime, left to right. The primary action, and only that. */
    fun primarySweep(startX: Float, endX: Float): Brush = Brush.horizontalGradient(
        0f to VanessaPalette.BlueSoft,
        0.45f to VanessaPalette.Cyan,
        1f to VanessaPalette.Lime,
        startX = startX,
        endX = endX,
    )

    /** Unbounded variant for composables that fill a shaped surface. */
    val primarySweepBrush: Brush = Brush.horizontalGradient(
        listOf(VanessaPalette.BlueSoft, VanessaPalette.Cyan, VanessaPalette.Lime),
    )

    /** Secondary control: dark fill, blue-grey border. */
    val secondaryFill: Brush = Brush.verticalGradient(
        listOf(Color(0xFF121B2E), Color(0xFF0B1220)),
    )

    /** The faint top-lit sheen shared by cards. */
    val cardSheen: Brush = Brush.verticalGradient(
        listOf(Color(0x16FFFFFF), Color(0x00FFFFFF)),
    )
}

/** A modifier-level helper so screens do not hand-roll the same wash. */
internal fun Modifier.vanessaBackground(): Modifier = background(VanessaPalette.Obsidian)
