package com.vanessa.mobile.ui.components

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.graphics.drawscope.rotate
import com.vanessa.mobile.ui.theme.VanessaPalette
import kotlin.math.cos
import kotlin.math.sin

private const val DEG_TO_RAD = 0.017453292f

/**
 * One orbit around the sphere.
 *
 * [squash] is the ellipse's minor/major ratio, so a small value reads as a ring
 * seen almost edge-on and a large one as a ring tilted towards the viewer.
 * [accent] is the colour of the light node travelling the ring — one ring
 * carries a lime node so the orbit picks up the accent colour once per lap
 * rather than being uniformly blue.
 */
internal data class OrbitalRing(
    val rotationDegrees: Float,
    val squash: Float,
    val scale: Float,
    val color: Color,
    val accent: Color,
    val alpha: Float,
    val nodeSpeed: Float,
    val nodePhase: Float,
    val strokeScale: Float,
)

/**
 * Deterministic ring set for a given time.
 *
 * Energy tightens and speeds the orbit: at rest the rings drift, while the
 * listening and executing states drive them faster. Nothing here depends on
 * randomness, so a recomposition can never reshuffle the composition.
 */
internal fun orbitalRings(time: Float, count: Int, energy: Float): List<OrbitalRing> {
    val speed = 0.15f + energy * 0.30f
    return List(count) { index ->
        val phase = time * speed * (1f + index * 0.18f) + index * 1.9f
        OrbitalRing(
            rotationDegrees = -26f + index * 10f + sin(phase) * 3.5f,
            squash = 0.17f + index * 0.055f,
            scale = 1.20f + index * 0.13f,
            color = when (index % 3) {
                0 -> VanessaPalette.BlueSoft
                1 -> VanessaPalette.Cyan
                else -> VanessaPalette.Brand
            },
            accent = if (index == 1) VanessaPalette.Lime else VanessaPalette.Cyan,
            alpha = 0.34f - index * 0.06f,
            nodeSpeed = speed * 1.1f + index * 0.04f,
            nodePhase = phase * 0.8f,
            strokeScale = 0.007f - index * 0.0012f,
        )
    }
}

/**
 * Draws the rings either entirely behind the sphere ([front] = false) or
 * entirely in front of it ([front] = true).
 *
 * Splitting on the sphere's equator is what sells the illusion: the far half of
 * each orbit disappears behind the body and the near half crosses over it, so
 * the rings read as encircling a solid object instead of being drawn on top of
 * a circle. The caller draws the sphere in between the two passes.
 */
internal fun DrawScope.drawOrbitalRings(
    rings: List<OrbitalRing>,
    center: Offset,
    radius: Float,
    front: Boolean,
    time: Float,
) {
    if (radius <= 0f || rings.isEmpty()) return
    val reach = radius * 3f
    clipRect(
        left = center.x - reach,
        top = if (front) center.y else center.y - reach,
        right = center.x + reach,
        bottom = if (front) center.y + reach else center.y,
    ) {
        rings.forEach { ring ->
            val semiMajor = radius * ring.scale
            val semiMinor = semiMajor * ring.squash
            val stroke = (radius * ring.strokeScale).coerceAtLeast(0.7f)
            val fade = if (front) 1f else 0.5f

            rotate(ring.rotationDegrees, pivot = center) {
                drawOval(
                    color = ring.color.copy(alpha = ring.alpha * fade),
                    topLeft = Offset(center.x - semiMajor, center.y - semiMinor),
                    size = Size(semiMajor * 2f, semiMinor * 2f),
                    style = Stroke(width = stroke),
                )
                // A thinner, brighter hairline just inside the ring reads as
                // the lit edge of a ribbon rather than a wire.
                drawOval(
                    color = ring.color.copy(alpha = ring.alpha * 0.35f * fade),
                    topLeft = Offset(
                        center.x - semiMajor + stroke * 2.4f,
                        center.y - semiMinor + stroke * 2.4f,
                    ),
                    size = Size(
                        (semiMajor - stroke * 2.4f) * 2f,
                        (semiMinor - stroke * 2.4f) * 2f,
                    ),
                    style = Stroke(width = stroke * 0.45f),
                )
            }

            drawRingNode(ring, center, radius, time, front)
        }
    }
}

/** The light travelling the orbit. Only drawn on the half that is visible. */
private fun DrawScope.drawRingNode(
    ring: OrbitalRing,
    center: Offset,
    radius: Float,
    time: Float,
    front: Boolean,
) {
    val semiMajor = radius * ring.scale
    val semiMinor = semiMajor * ring.squash
    val angle = time * ring.nodeSpeed * 2f + ring.nodePhase
    val localX = cos(angle) * semiMajor
    val localY = sin(angle) * semiMinor

    // cos/sin of the ring's rotation, applied by hand so the node lands on the
    // same ellipse the ring was drawn as.
    val rotation = ring.rotationDegrees * DEG_TO_RAD
    val x = center.x + localX * cos(rotation) - localY * sin(rotation)
    val y = center.y + localX * sin(rotation) + localY * cos(rotation)

    val isNearHalf = localY > 0f
    if (isNearHalf != front) return

    val glowRadius = radius * 0.085f
    drawCircle(
        brush = Brush.radialGradient(
            colors = listOf(ring.accent.copy(alpha = 0.42f), Color.Transparent),
            center = Offset(x, y),
            radius = glowRadius,
        ),
        radius = glowRadius,
        center = Offset(x, y),
    )
    drawCircle(
        color = ring.accent.copy(alpha = 0.85f),
        radius = (radius * 0.013f).coerceAtLeast(1.1f),
        center = Offset(x, y),
    )
}
