package com.vanessa.mobile.ui.components

import com.vanessa.mobile.ui.rememberMotionClock
import com.vanessa.mobile.ui.theme.VanessaPalette

import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.drawscope.scale
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

/**
 * The flowing N-waveform: Vanessa's energy field.
 *
 * Deliberately not an equaliser. These are overlapping luminous ribbons on
 * smooth sine curves with differing amplitudes, frequencies and drift
 * directions, drawn back to front (deep navy → cobalt → cyan → lime) so the
 * composite reads as energy suspended in space rather than stacked bars.
 *
 * [intensity] scales amplitude. It is driven by the assistant's *state* —
 * idle, listening, thinking, complete — because Android's speech recogniser
 * does not expose a live input level. The motion is therefore an honest
 * indication of state, not a claimed measurement of the microphone.
 */
@Composable
internal fun EnergyWave(
    modifier: Modifier = Modifier,
    intensity: Float = 1f,
) {
    val clock = rememberMotionClock()
    Canvas(modifier = modifier) {
        drawWaveform(
            time = clock.value,
            intensity = intensity.coerceIn(0f, 1.6f),
        )
    }
}

private data class WaveRibbon(
    val color: Color,
    val width: Float,
    val amplitude: Float,
    val frequency: Float,
    val speed: Float,
    val alpha: Float,
    val litCore: Boolean,
)

private val WAVE_RIBBONS = listOf(
    WaveRibbon(Color(0xFF0B2A6B), 0.030f, 0.92f, 1.05f, 0.16f, 0.55f, false),
    WaveRibbon(VanessaPalette.Brand, 0.020f, 0.74f, 1.35f, 0.24f, 0.95f, true),
    WaveRibbon(VanessaPalette.Cyan, 0.014f, 0.56f, 1.65f, -0.30f, 0.85f, true),
    WaveRibbon(VanessaPalette.Lime, 0.012f, 0.40f, 1.95f, 0.36f, 0.80f, true),
)

private const val TAU_WAVE = 6.2831855f

private fun DrawScope.drawWaveform(time: Float, intensity: Float) {
    val width = size.width
    val height = size.height
    if (width <= 0f || height <= 0f) return

    val midY = height * 0.52f

    // Reflected light under the ribbons. A plain fill rectangle would show
    // its own edges as a hard box on a black screen; this radial gradient
    // reaches zero in every direction on its own.
    val floorCenter = Offset(width * 0.5f, midY + height * 0.12f)
    scale(scaleX = 1f, scaleY = 0.55f, pivot = floorCenter) {
        drawCircle(
            brush = Brush.radialGradient(
                0f to VanessaPalette.Brand.copy(alpha = 0.10f * intensity),
                0.4f to VanessaPalette.Brand.copy(alpha = 0.045f * intensity),
                0.72f to VanessaPalette.Brand.copy(alpha = 0.012f * intensity),
                1f to Color.Transparent,
                center = floorCenter,
                radius = width * 0.56f,
            ),
            radius = width * 0.56f,
            center = floorCenter,
        )
    }

    WAVE_RIBBONS.forEachIndexed { index, ribbon ->
        val amplitude = height * 0.34f * ribbon.amplitude * intensity
        if (amplitude <= 0f) return@forEachIndexed
        val k = (TAU_WAVE * ribbon.frequency) / width
        val phase = time * ribbon.speed * TAU_WAVE * 0.28f + index * 1.7f
        val step = (width / 180f).coerceAtLeast(2f)

        val path = Path()
        var x = 0f
        while (x <= width) {
            // Two superposed sines give the organic, non-repeating shape.
            val primary = sin(x * k + phase)
            val secondary = sin(x * k * 2.37f - phase * 1.6f) * 0.34f
            val envelope = 0.72f + 0.28f * sin((x / width) * PI.toFloat())
            val y = midY + (primary + secondary) * amplitude * 0.5f * envelope
            if (x == 0f) path.moveTo(x, y) else path.lineTo(x, y)
            x += step
        }

        val lineWidth = (height * ribbon.width).coerceAtLeast(1.2f)

        // Soft bloom substitute for canvas shadowBlur: two translucent
        // strokes beneath the ribbon, then the ribbon, then a lit core.
        drawPath(
            path = path,
            color = ribbon.color.copy(alpha = ribbon.alpha * 0.10f),
            style = Stroke(width = lineWidth * 5f, cap = StrokeCap.Round, join = StrokeJoin.Round),
        )
        drawPath(
            path = path,
            color = ribbon.color.copy(alpha = ribbon.alpha * 0.28f),
            style = Stroke(width = lineWidth * 2.2f, cap = StrokeCap.Round, join = StrokeJoin.Round),
        )
        drawPath(
            path = path,
            color = ribbon.color.copy(alpha = ribbon.alpha),
            style = Stroke(width = lineWidth, cap = StrokeCap.Round, join = StrokeJoin.Round),
        )
        if (ribbon.litCore) {
            drawPath(
                path = path,
                color = Color(0xFFDFF3FF).copy(alpha = 0.34f),
                style = Stroke(
                    width = (lineWidth * 0.32f).coerceAtLeast(0.6f),
                    cap = StrokeCap.Round,
                    join = StrokeJoin.Round,
                ),
            )
        }
    }
}

/**
 * Circular progress arcs for the executing screen.
 *
 * Two flat arcs — cobalt on the lower left, lime on the upper right — plus a
 * slow travelling tick. There is no percentage text because Vanessa cannot
 * report a real completion percentage for a streamed generation; inventing
 * one would be fake precision.
 */
@Composable
internal fun ProgressRing(
    modifier: Modifier = Modifier,
    progress: Float = 0.42f,
) {
    val clock = rememberMotionClock()
    Canvas(modifier = modifier) {
        val radius = size.minDimension * 0.455f
        if (radius <= 0f) return@Canvas
        val center = Offset(size.width / 2f, size.height / 2f)
        val sweep = progress.coerceIn(0f, 1f)

        drawCircle(
            color = VanessaPalette.TextSecondary.copy(alpha = 0.16f),
            radius = radius,
            center = center,
            style = Stroke(width = (radius * 0.035f).coerceAtLeast(2f)),
        )

        drawArc(
            brush = Brush.linearGradient(
                colors = listOf(VanessaPalette.Brand, VanessaPalette.Cyan),
                start = Offset(center.x - radius, center.y - radius),
                end = Offset(center.x + radius, center.y + radius),
            ),
            startAngle = 99f,
            sweepAngle = 171f * (0.35f + 0.65f * sweep),
            useCenter = false,
            topLeft = Offset(center.x - radius, center.y - radius),
            size = Size(radius * 2f, radius * 2f),
            style = Stroke(width = (radius * 0.05f).coerceAtLeast(2.4f), cap = StrokeCap.Round),
        )

        drawArc(
            brush = Brush.linearGradient(
                colors = listOf(VanessaPalette.Lime, Color(0xFFD4FF8F)),
                start = Offset(center.x - radius, center.y + radius),
                end = Offset(center.x + radius, center.y - radius),
            ),
            startAngle = 292f,
            sweepAngle = 207f * (0.30f + 0.55f * sweep),
            useCenter = false,
            topLeft = Offset(center.x - radius, center.y - radius),
            size = Size(radius * 2f, radius * 2f),
            style = Stroke(width = (radius * 0.05f).coerceAtLeast(2.4f), cap = StrokeCap.Round),
        )

        val tick = clock.value * 0.9f
        drawCircle(
            color = VanessaPalette.Cyan.copy(alpha = 0.95f),
            radius = (radius * 0.022f).coerceAtLeast(1.6f),
            center = Offset(
                center.x + cos(tick) * radius,
                center.y + sin(tick) * radius,
            ),
        )
    }
}

/**
 * The vertical electric-blue beam that falls from the top edge of the welcome
 * screen. Two gradients: a wide soft column and a narrow hot core.
 */
@Composable
internal fun LightBeam(modifier: Modifier = Modifier) {
    Canvas(modifier = modifier) {
        val width = size.width
        val height = size.height
        if (width <= 0f || height <= 0f) return@Canvas
        val x = width / 2f

        drawRect(
            brush = Brush.horizontalGradient(
                0f to Color.Transparent,
                0.5f to VanessaPalette.Brand.copy(alpha = 0.30f),
                1f to Color.Transparent,
                startX = 0f,
                endX = width,
            ),
            topLeft = Offset.Zero,
            size = Size(width, height),
        )

        rotate(degrees = 0f, pivot = Offset(x, 0f)) {
            drawRect(
                brush = Brush.verticalGradient(
                    0f to VanessaPalette.Cyan.copy(alpha = 0.55f),
                    0.55f to VanessaPalette.Brand.copy(alpha = 0.10f),
                    1f to Color.Transparent,
                    startY = 0f,
                    endY = height,
                ),
                topLeft = Offset(x - width * 0.03f, 0f),
                size = Size(width * 0.06f, height * 0.86f),
            )
        }
    }
}
