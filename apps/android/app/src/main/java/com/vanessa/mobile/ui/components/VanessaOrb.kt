package com.vanessa.mobile.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.res.imageResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import com.vanessa.mobile.R
import com.vanessa.mobile.ui.rememberMotionClock
import com.vanessa.mobile.ui.theme.VanessaPalette
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.random.Random

/**
 * The Vanessa sphere.
 *
 * The body itself is a rendered asset — a deliberate choice over drawing a
 * sphere from hundreds of primitives. A real render carries the sub-surface
 * falloff, the glass sheen and the rim gradient that make the object read as
 * physical, and it costs one textured quad per frame instead of a thousand
 * draw calls. The asset ships with its own alpha, feathered just outside the
 * silhouette, so it composites onto any background without a visible edge.
 *
 * Everything that has to *move* is drawn on top in Compose:
 *
 *   bloom → orbits behind → particles behind → sphere → travelling rim
 *     → cyan glint → lime spill → orbits in front → particles in front
 *     → optional completion check
 *
 * The division is the point. Lighting baked into a still image cannot respond
 * to the microphone, the model or the task runtime; these layers can, which is
 * why the orb is one component rather than a picture per screen.
 */
@Composable
internal fun VanessaOrb(
    size: Dp,
    energy: Float,
    offline: Boolean,
    modifier: Modifier = Modifier,
    ringCount: Int = 3,
    showParticles: Boolean = true,
    showCheck: Boolean = false,
    description: String? = "Vanessa orb",
) {
    val clock = rememberMotionClock()
    val particles = remember { orbParticleField() }
    val sphere = ImageBitmap.imageResource(R.drawable.vanessa_sphere)
    val semanticsModifier = if (description == null) {
        Modifier
    } else {
        val text = description
        Modifier.semantics { contentDescription = text }
    }

    Canvas(modifier = modifier.size(size).then(semanticsModifier)) {
        drawVanessaOrb(
            time = clock.value,
            energy = energy.coerceIn(0f, 1f),
            offline = offline,
            ringCount = ringCount,
            showParticles = showParticles,
            showCheck = showCheck,
            particles = particles,
            sphere = sphere,
        )
    }
}

private const val TAU = 6.2831855f

/**
 * The rendered sphere's silhouette sits at ~0.47 of the asset's width, so the
 * asset has to be drawn slightly larger than the diameter the caller asked for
 * for the *sphere* to be that size.
 */
private const val SILHOUETTE_FRACTION = 0.95f

private data class OrbParticle(
    val angle: Float,
    val radius: Float,
    val speed: Float,
    val size: Float,
    val color: Color,
    val twinkle: Float,
)

private fun orbParticleField(): List<OrbParticle> {
    val random = Random(11)
    return List(26) {
        val lime = random.nextFloat() > 0.72f
        OrbParticle(
            angle = random.nextFloat() * TAU,
            radius = 1.16f + random.nextFloat() * 0.62f,
            speed = 0.10f + random.nextFloat() * 0.26f,
            size = 0.6f + random.nextFloat() * 1.5f,
            color = if (lime) VanessaPalette.Lime else VanessaPalette.Cyan,
            twinkle = random.nextFloat() * TAU,
        )
    }
}

private fun DrawScope.drawVanessaOrb(
    time: Float,
    energy: Float,
    offline: Boolean,
    ringCount: Int,
    showParticles: Boolean,
    showCheck: Boolean,
    particles: List<OrbParticle>,
    sphere: ImageBitmap,
) {
    val center = Offset(size.width / 2f, size.height / 2f)
    val sphereDiameter = min(size.width, size.height) * 0.94f
    if (sphereDiameter <= 0f) return
    val radius = sphereDiameter / 2f
    val dim = if (offline) 0.4f else 1f

    // Float: a slow vertical drift, 5.2 s per cycle, so the object never looks
    // pinned to the layout.
    val floatY = sin(time * TAU / 5.2f) * radius * 0.045f
    val bodyCenter = Offset(center.x, center.y + floatY)
    val breathe = 1f + sin(time * TAU / 4.6f) * 0.006f

    drawBloom(center, radius, energy, dim)

    if (ringCount > 0) {
        drawOrbitalRings(orbitalRings(time, ringCount, energy), center, radius, front = false, time = time)
    }
    if (showParticles) drawParticles(particles, time, center, radius, front = false, dim = dim)

    // The asset, sized so its silhouette is the requested diameter.
    val spriteEdge = sphereDiameter / SILHOUETTE_FRACTION * breathe
    val spriteRadius = spriteEdge / 2f
    val left = (bodyCenter.x - spriteRadius).roundToInt()
    val top = (bodyCenter.y - spriteRadius).roundToInt()
    drawImage(
        image = sphere,
        srcOffset = IntOffset.Zero,
        srcSize = IntSize(sphere.width, sphere.height),
        dstOffset = IntOffset(left, top),
        dstSize = IntSize(spriteEdge.roundToInt(), spriteEdge.roundToInt()),
        filterQuality = FilterQuality.High,
    )

    // Animated light, clipped to the body so it can never spill past the rim.
    val bodyPath = Path().apply { addOval(Rect(center = bodyCenter, radius = radius)) }
    clipPath(bodyPath) {
        drawTravellingRim(bodyCenter, radius, time, energy, dim)
        drawCyanGlint(bodyCenter, radius, time, energy, dim)
        if (!offline) drawLimeSpill(bodyCenter, radius, time, energy)
        drawInnerShadow(bodyCenter, radius)
    }

    if (ringCount > 0) {
        drawOrbitalRings(orbitalRings(time, ringCount, energy), center, radius, front = true, time = time)
    }
    if (showParticles) drawParticles(particles, time, center, radius, front = true, dim = dim)

    if (showCheck) drawCompletionCheck(bodyCenter, radius, time)
}

/** Soft cobalt haze behind the body. Energy widens and brightens it. */
private fun DrawScope.drawBloom(center: Offset, radius: Float, energy: Float, dim: Float) {
    val bloomRadius = radius * (1.55f + energy * 0.35f)
    val alpha = (0.10f + 0.20f * energy) * dim
    drawCircle(
        brush = Brush.radialGradient(
            colors = listOf(
                VanessaPalette.Brand.copy(alpha = alpha),
                VanessaPalette.Navy.copy(alpha = alpha * 0.55f),
                Color.Transparent,
            ),
            center = center,
            radius = bloomRadius,
        ),
        radius = bloomRadius,
        center = center,
    )
}

/**
 * A highlight that travels the rim once every ~9 s. This is what stops the
 * sphere from looking like a photograph: the light moves, slowly, along the
 * silhouette the way a studio light would if the object were turning.
 */
private fun DrawScope.drawTravellingRim(
    center: Offset,
    radius: Float,
    time: Float,
    energy: Float,
    dim: Float,
) {
    val sweep = 92f
    val start = (time * 20f) % 360f
    val alpha = (0.16f + 0.20f * energy) * dim
    rotate(start, pivot = center) {
        drawArc(
            brush = Brush.sweepGradient(
                colors = listOf(
                    Color.Transparent,
                    VanessaPalette.Cyan.copy(alpha = alpha),
                    VanessaPalette.BlueSoft.copy(alpha = alpha * 0.8f),
                    Color.Transparent,
                ),
                center = center,
            ),
            startAngle = 0f,
            sweepAngle = 360f,
            useCenter = false,
            topLeft = Offset(center.x - radius, center.y - radius),
            size = Size(radius * 2f, radius * 2f),
            style = Stroke(width = radius * 0.05f),
        )
        drawArc(
            color = VanessaPalette.Cyan.copy(alpha = alpha * 0.9f),
            startAngle = -sweep / 2f,
            sweepAngle = sweep,
            useCenter = false,
            topLeft = Offset(center.x - radius * 0.985f, center.y - radius * 0.985f),
            size = Size(radius * 1.97f, radius * 1.97f),
            style = Stroke(width = radius * 0.022f, cap = StrokeCap.Round),
        )
    }
}

/** The cold specular highlight at the upper left, breathing with energy. */
private fun DrawScope.drawCyanGlint(
    center: Offset,
    radius: Float,
    time: Float,
    energy: Float,
    dim: Float,
) {
    val pulse = 0.78f + 0.22f * sin(time * 1.4f)
    val alpha = (0.22f + 0.30f * energy) * pulse * dim
    val position = Offset(center.x - radius * 0.63f, center.y - radius * 0.63f)
    val glowRadius = radius * 0.30f
    drawCircle(
        brush = Brush.radialGradient(
            colors = listOf(VanessaPalette.Cyan.copy(alpha = alpha), Color.Transparent),
            center = position,
            radius = glowRadius,
        ),
        radius = glowRadius,
        center = position,
    )
}

/** Warm lime grazing the lower-right edge. The only warm light in the app. */
private fun DrawScope.drawLimeSpill(center: Offset, radius: Float, time: Float, energy: Float) {
    val pulse = 0.72f + 0.28f * sin(time * 1.1f + 0.7f)
    val alpha = (0.16f + 0.22f * energy) * pulse
    rotate(0f, pivot = center) {
        drawArc(
            brush = Brush.sweepGradient(
                colors = listOf(
                    Color.Transparent,
                    VanessaPalette.Lime.copy(alpha = alpha),
                    Color.Transparent,
                ),
                center = center,
            ),
            startAngle = 90f,
            sweepAngle = 360f,
            useCenter = false,
            topLeft = Offset(center.x - radius * 0.99f, center.y - radius * 0.99f),
            size = Size(radius * 1.98f, radius * 1.98f),
            style = Stroke(width = radius * 0.045f),
        )
    }
}

/** Darkens the rim's inner edge so the body keeps a black core. */
private fun DrawScope.drawInnerShadow(center: Offset, radius: Float) {
    drawCircle(
        brush = Brush.radialGradient(
            colors = listOf(
                Color.Transparent,
                Color.Transparent,
                Color.Black.copy(alpha = 0.42f),
            ),
            center = center,
            radius = radius,
        ),
        radius = radius,
        center = center,
    )
}

private fun DrawScope.drawParticles(
    particles: List<OrbParticle>,
    time: Float,
    center: Offset,
    radius: Float,
    front: Boolean,
    dim: Float,
) {
    particles.forEach { particle ->
        val isLime = particle.color == VanessaPalette.Lime
        if (isLime != front) return@forEach
        val angle = particle.angle + time * particle.speed
        val x = center.x + kotlin.math.cos(angle) * radius * particle.radius
        val y = center.y + sin(angle) * radius * particle.radius * 0.52f
        val twinkle = 0.30f + 0.70f * (0.5f + 0.5f * sin(time * 1.5f + particle.twinkle))
        drawCircle(
            color = particle.color.copy(alpha = 0.5f * twinkle * dim),
            radius = particle.size,
            center = Offset(x, y),
        )
    }
}

/** Completion state. Sweeps in once, then holds, on a 650 ms pulse. */
private fun DrawScope.drawCompletionCheck(center: Offset, radius: Float, time: Float) {
    val settle = (time / 0.55f).coerceIn(0f, 1f)
    if (settle <= 0f) return
    val check = Path().apply {
        moveTo(center.x - radius * 0.30f, center.y + radius * 0.02f)
        lineTo(center.x - radius * 0.06f, center.y + radius * 0.26f)
        lineTo(center.x + radius * 0.34f, center.y - radius * 0.22f)
    }
    val glow = 0.35f * settle * (0.85f + 0.15f * sin(time * 2.2f))
    drawPath(
        path = check,
        color = VanessaPalette.Lime.copy(alpha = glow),
        style = Stroke(width = radius * 0.17f * settle, cap = StrokeCap.Round, join = StrokeJoin.Round),
    )
    drawPath(
        path = check,
        color = VanessaPalette.Lime.copy(alpha = settle),
        style = Stroke(width = radius * 0.09f * settle, cap = StrokeCap.Round, join = StrokeJoin.Round),
    )
}
