package com.vanessa.mobile.ui.theme

import androidx.compose.ui.unit.dp

/**
 * Geometry and timing, in one place.
 *
 * The radii follow the board: cards sit between 16 and 22 dp, controls and
 * inputs at 16 dp, pills fully rounded. The orb fractions are the "25–35 % of
 * screen width" rule expressed once, so no screen invents its own size.
 */
internal object VanessaRadius {
    val card = 20.dp
    val cardLarge = 22.dp
    val control = 16.dp
    val chip = 999.dp
}

internal object VanessaSpacing {
    val xs = 6.dp
    val s = 10.dp
    val m = 14.dp
    val l = 20.dp
    val xl = 28.dp

    /** Horizontal page inset used by every screen. */
    val inset = 22.dp
}

/** Orb sizes as a fraction of the screen width. */
internal object VanessaOrbSize {
    /** Hero screens: welcome, listening. */
    const val hero = 0.34f

    /** Chat header, completion. */
    const val standard = 0.24f

    /** Inline confirmation or row decoration. */
    const val compact = 0.16f
}

/**
 * Motion timings from the board, in milliseconds.
 *
 * Read by [com.vanessa.mobile.ui.components] and the screens so the same
 * rhythm is felt everywhere. Every animated element still honours the system
 * animator scale — see `rememberMotionClock`.
 */
internal object VanessaMotionSpec {
    /** Orb float cycle. Board asks for 4–6 s. */
    const val floatMillis = 5200

    /** Orbit rotation. Board asks for 8–14 s. */
    const val orbitMillis = 11000

    /** Ambient wave cycle. Board asks for 3–5 s. */
    const val waveMillis = 4000

    /** Button press response. Board asks for 150–220 ms. */
    const val pressMillis = 170

    /** Screen transition. Board asks for 300–450 ms. */
    const val transitionMillis = 380

    /** Completion pulse. Board asks for 500–800 ms. */
    const val pulseMillis = 650
}
