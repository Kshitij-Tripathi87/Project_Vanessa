package com.vanessa.mobile.ui

import android.content.Context
import android.provider.Settings
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.platform.LocalContext

/**
 * A monotonic seconds clock driven by the display's frame signal.
 *
 * Every animated element owns its own clock, which is what the design spec
 * asks for: the orb floats on a 4–6 s cycle while its rings, particles and
 * waveform each run at independent speeds. Sharing one global clock would
 * lock them into an obvious, lifeless sync.
 *
 * Returned as [State] on purpose. Composables read it *inside* a draw lambda
 * so a new frame invalidates drawing only — reading it in composition would
 * recompose every animated subtree on every frame.
 *
 * The clock honours the system animator duration scale: when the user has
 * turned animations off (scale 0), the loop never starts and every element
 * renders its frame-zero pose instead of moving.
 */
@Composable
internal fun rememberMotionClock(): State<Float> {
    val context = LocalContext.current
    val animate = remember(context) { animationsEnabled(context) }
    val clock = remember { mutableStateOf(0f) }

    LaunchedEffect(animate) {
        if (!animate) return@LaunchedEffect
        var previous = 0L
        while (true) {
            withFrameNanos { frameTimeNanos ->
                if (previous != 0L) {
                    val delta = (frameTimeNanos - previous) / 1_000_000_000f
                    // Clamp so a backgrounded tab or a stalled frame cannot
                    // make the animation jump forward.
                    clock.value += delta.coerceIn(0f, 0.05f)
                }
                previous = frameTimeNanos
            }
        }
    }

    return clock
}

private fun animationsEnabled(context: Context): Boolean = runCatching {
    Settings.Global.getFloat(
        context.contentResolver,
        Settings.Global.ANIMATOR_DURATION_SCALE,
        1f,
    ) > 0f
}.getOrDefault(true)
