package com.vanessa.mobile.ui

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
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlin.math.cos
import kotlin.math.sin
import kotlin.random.Random

private const val TAU = 6.2831855f
private const val DEG_TO_RAD = 0.017453292f
private const val RAD_TO_DEG = 57.29578f

/**
 * The Vanessa orb — the brand mark, and the only one the product has.
 *
 * Ported from the reference renderer in `apps/vanessa-ui-prototype/js/orb.js`.
 * It is not a disc with a coloured outline: the body is near-black glass, and
 * almost all the light lives in a thin fresnel rim that wraps the silhouette,
 * a tight specular glint at the upper left, and a lime spill confined to the
 * lower-right edge. That is what makes it read as a lit physical object.
 *
 * Each pass is separate so the layers can move independently:
 *
 *   bloom → rings behind → particles behind → body → inner breath
 *     → cobalt rim (upper left) → cyan highlight → specular glint
 *     → lime spill (lower right) → hot bottom rim → glass sheen
 *     → rings in front → particles in front → optional completion check
 *
 * The Compose canvas has no shadow blur, so the reference's `shadowBlur` glow
 * is replaced by stacked translucent strokes and gradients that fall to zero
 * before their own edges. No hard seams, no card-like glow boxes.
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
    val semanticsModifier = if (description == null) {
        Modifier
    } else {
        val text = description
        Modifier.semantics { contentDescription = text }
    }

    Canvas(modifier = modifier.size(size).then(semanticsModifier)) {
        drawOrb(
            time = clock.value,
            energy = energy.coerceIn(0f, 1f),
            offline = offline,
            ringCount = ringCount,
            showParticles = showParticles,
            showCheck = showCheck,
            particles = particles,
        )
    }
}

private data class OrbitRing(
    val rotationDegrees: Float,
    val squash: Float,
    val scale: Float,
    val color: Color,
    val alpha: Float,
    val node: Boolean,
    val nodePhase: Float,
)

private data class OrbitParticle(
    val angle: Float,
    val radius: Float,
    val speed: Float,
    val size: Float,
    val color: Color,
    val twinkle: Float,
)

/**
 * Deterministic field so a recomposition (or a rotation) cannot reshuffle the
 * specks, which would read as digital noise rather than atmosphere.
 */
private fun orbParticleField(): List<OrbitParticle> {
    val random = Random(7)
    return List(22) {
        OrbitParticle(
            angle = random.nextFloat() * TAU,
            radius = 0.52f + random.nextFloat() * 0.44f,
            speed = (0.04f + random.nextFloat() * 0.10f) * if (random.nextBoolean()) 1f else -1f,
            size = 0.5f + random.nextFloat() * 1.3f,
            color = when {
                random.nextFloat() > 0.80f -> VanessaPalette.Lime
                random.nextFloat() > 0.42f -> VanessaPalette.Cyan
                else -> VanessaPalette.BlueSoft
            },
            twinkle = random.nextFloat() * TAU,
        )
    }
}

private fun orbitRings(time: Float, count: Int): List<OrbitRing> = List(count) { index ->
    val phase = time * (0.14f + index * 0.045f) + index * 2.1f
    OrbitRing(
        rotationDegrees = (-0.34f + index * 0.17f + sin(phase) * 0.06f) * RAD_TO_DEG,
        squash = 0.17f + index * 0.075f,
        scale = 1.34f + index * 0.16f,
        color = if (index == 1) VanessaPalette.Cyan else VanessaPalette.BlueSoft,
        alpha = 0.42f - index * 0.08f,
        node = index % 2 == 0,
        nodePhase = phase,
    )
}

private fun DrawScope.drawOrb(
    time: Float,
    energy: Float,
    offline: Boolean,
    ringCount: Int,
    showParticles: Boolean,
    showCheck: Boolean,
    particles: List<OrbitParticle>,
) {
    val side = size.minDimension
    if (side <= 0f) return

    // A dimmed orb is a state signal ("no model"), not a different asset.
    val light = if (offline) 0.4f else 1f
    val bob = sin(time * 0.55f) * side * 0.010f
    val center = Offset(size.width / 2f, size.height / 2f + bob)
    val radius = side * 0.345f
    val rings = orbitRings(time, ringCount)

    // ── outer bloom: the only light that escapes the silhouette ──────────
    val bloomRadius = radius * (1.5f + energy * 0.2f)
    drawCircle(
        brush = Brush.radialGradient(
            0f to VanessaPalette.Brand.copy(alpha = (0.14f + energy * 0.14f) * light),
            0.45f to VanessaPalette.Brand.copy(alpha = 0.045f * light),
            1f to Color.Transparent,
            center = center,
            radius = bloomRadius,
        ),
        radius = bloomRadius,
        center = center,
    )

    rings.forEachIndexed { index, ring ->
        if (index % 2 == 0) drawOrbitRing(ring, center, radius, light)
    }
    if (showParticles) drawOrbParticles(particles, time, center, radius, front = false)

    // ── body: black glass. The centre stays essentially black. ───────────
    drawCircle(
        brush = Brush.radialGradient(
            0f to Color(0xFF0B111C),
            0.38f to Color(0xFF06090F),
            0.70f to Color(0xFF03050A),
            1f to Color(0xFF010204),
            center = Offset(center.x - radius * 0.26f, center.y - radius * 0.30f),
            radius = radius * 1.15f,
        ),
        radius = radius,
        center = center,
    )

    val bodyPath = Path().apply { addOval(Rect(center = center, radius = radius)) }

    // ── faint blue breath just inside the upper-left edge ────────────────
    clipPath(bodyPath) {
        drawCircle(
            brush = Brush.radialGradient(
                0f to VanessaPalette.BlueSoft.copy(alpha = (0.10f + energy * 0.07f) * light),
                0.5f to Color(0xFF072D8C).copy(alpha = 0.030f * light),
                1f to Color.Transparent,
                center = Offset(center.x - radius * 0.62f, center.y - radius * 0.64f),
                radius = radius * 0.95f,
            ),
            radius = radius * 0.95f,
            center = Offset(center.x - radius * 0.62f, center.y - radius * 0.64f),
        )
    }

    // ── cobalt fresnel rim, upper left (≈8 o'clock → 12:30) ──────────────
    drawRim(
        center = center,
        radius = radius,
        startDegrees = 158f,
        sweepDegrees = 130f,
        color = VanessaPalette.BlueSoft,
        alpha = (0.95f + energy * 0.05f) * light,
    )

    // ── cyan highlight riding inside that rim ────────────────────────────
    drawRim(
        center = center,
        radius = radius,
        startDegrees = 187f,
        sweepDegrees = 68f,
        color = Color(0xFF7FC8FF),
        alpha = (0.55f + energy * 0.25f) * light,
        spread = 0.6f,
        core = 0.7f,
    )

    // ── specular glint: tight, hot, upper left ───────────────────────────
    val glint = Offset(center.x - radius * 0.50f, center.y - radius * 0.55f)
    drawCircle(
        brush = Brush.radialGradient(
            0f to Color(0xFFE8F6FF).copy(alpha = (0.82f + energy * 0.18f) * light),
            0.12f to Color(0xFFB0E0FF).copy(alpha = 0.52f * light),
            0.34f to Color(0xFF46AAFF).copy(alpha = 0.18f * light),
            0.68f to VanessaPalette.Cyan.copy(alpha = 0.045f * light),
            1f to Color.Transparent,
            center = glint,
            radius = radius * 0.17f,
        ),
        radius = radius * 0.17f,
        center = glint,
    )

    // ── lime spill, lower-right edge only ────────────────────────────────
    drawRim(
        center = center,
        radius = radius,
        startDegrees = -11f,
        sweepDegrees = 76f,
        color = VanessaPalette.Lime,
        alpha = (0.62f + energy * 0.30f) * light,
    )
    clipPath(bodyPath) {
        val spill = Offset(center.x + radius * 0.78f, center.y + radius * 0.52f)
        drawCircle(
            brush = Brush.radialGradient(
                0f to VanessaPalette.Lime.copy(alpha = (0.22f + energy * 0.16f) * light),
                0.5f to VanessaPalette.Lime.copy(alpha = 0.05f * light),
                1f to Color.Transparent,
                center = spill,
                radius = radius * 0.46f,
            ),
            radius = radius * 0.46f,
            center = spill,
        )
    }

    // ── hot blue-white bottom rim (≈4:30 → 7:30) ─────────────────────────
    drawRim(
        center = center,
        radius = radius,
        startDegrees = 58f,
        sweepDegrees = 118f,
        color = Color(0xFFC8E9FF),
        alpha = 0.92f * light,
    )

    // ── glass sheen: barely there, so the body stays black ───────────────
    val sheenCenter = Offset(center.x - radius * 0.26f, center.y - radius * 0.56f)
    clipPath(bodyPath) {
        rotate(degrees = -31.5f, pivot = sheenCenter) {
            scale(scaleX = 1f, scaleY = 0.42f, pivot = sheenCenter) {
                drawCircle(
                    brush = Brush.radialGradient(
                        0f to Color(0xFFAAD7FF).copy(alpha = 0.085f * light),
                        0.45f to Color(0xFFAAD7FF).copy(alpha = 0.030f * light),
                        0.75f to Color(0xFFAAD7FF).copy(alpha = 0.008f * light),
                        1f to Color.Transparent,
                        center = sheenCenter,
                        radius = radius * 0.62f,
                    ),
                    radius = radius * 0.62f,
                    center = sheenCenter,
                )
            }
        }
    }

    rings.forEachIndexed { index, ring ->
        if (index % 2 == 1) drawOrbitRing(ring, center, radius, light)
    }
    if (showParticles) drawOrbParticles(particles, time, center, radius, front = true)

    if (showCheck) drawCompletionCheck(center, radius, time)
}

/**
 * A fresnel rim across an angular sector.
 *
 * The light is stroked *on* the silhouette and faded out along the sector's
 * chord, so it dissolves into the dark instead of stopping at a hard angular
 * edge. Three stacked passes give the soft inward falloff the reference has:
 * wide bloom, mid glow, hot core.
 */
private fun DrawScope.drawRim(
    center: Offset,
    radius: Float,
    startDegrees: Float,
    sweepDegrees: Float,
    color: Color,
    alpha: Float,
    spread: Float = 1f,
    core: Float = 1f,
) {
    if (alpha <= 0f) return
    val startRadians = startDegrees * DEG_TO_RAD
    val endRadians = (startDegrees + sweepDegrees) * DEG_TO_RAD
    val from = Offset(
        center.x + cos(startRadians) * radius,
        center.y + sin(startRadians) * radius,
    )
    val to = Offset(
        center.x + cos(endRadians) * radius,
        center.y + sin(endRadians) * radius,
    )
    val brush = Brush.linearGradient(
        0f to color.copy(alpha = 0f),
        0.5f to color.copy(alpha = alpha.coerceIn(0f, 1f)),
        1f to color.copy(alpha = 0f),
        start = from,
        end = to,
    )

    fun pass(radiusFactor: Float, widthFactor: Float, passAlpha: Float) {
        val passRadius = radius * radiusFactor
        drawArc(
            brush = brush,
            startAngle = startDegrees,
            sweepAngle = sweepDegrees,
            useCenter = false,
            topLeft = Offset(center.x - passRadius, center.y - passRadius),
            size = Size(passRadius * 2f, passRadius * 2f),
            alpha = passAlpha,
            style = Stroke(
                width = (radius * widthFactor).coerceAtLeast(1f),
                cap = StrokeCap.Round,
            ),
        )
    }

    pass(1.000f, 0.052f * spread, 0.20f * core)
    pass(0.994f, 0.020f * spread, 0.46f * core)
    pass(0.987f, 0.0075f, 1.00f * core)
}

private fun DrawScope.drawOrbitRing(
    ring: OrbitRing,
    center: Offset,
    radius: Float,
    light: Float,
) {
    val ringRadius = radius * ring.scale
    val alpha = (ring.alpha * light).coerceIn(0f, 1f)
    if (alpha <= 0f) return

    rotate(degrees = ring.rotationDegrees, pivot = center) {
        drawOval(
            brush = Brush.linearGradient(
                colors = listOf(
                    ring.color.copy(alpha = alpha * 0.15f),
                    ring.color.copy(alpha = alpha),
                    ring.color.copy(alpha = alpha * 0.15f),
                ),
                start = Offset(center.x - ringRadius, center.y),
                end = Offset(center.x + ringRadius, center.y),
            ),
            topLeft = Offset(center.x - ringRadius, center.y - ringRadius * ring.squash),
            size = Size(ringRadius * 2f, ringRadius * 2f * ring.squash),
            style = Stroke(width = (radius * 0.010f).coerceAtLeast(0.9f)),
        )
    }

    if (ring.node) {
        // A travelling highlight, as if light were catching the ring.
        val angle = ring.nodePhase * 0.9f
        val ellipseX = cos(angle) * ringRadius
        val ellipseY = sin(angle) * ringRadius * ring.squash
        val rotation = ring.rotationDegrees * DEG_TO_RAD
        val nodeX = ellipseX * cos(rotation) - ellipseY * sin(rotation)
        val nodeY = ellipseX * sin(rotation) + ellipseY * cos(rotation)
        val nodeCenter = Offset(center.x + nodeX, center.y + nodeY)
        drawCircle(
            brush = Brush.radialGradient(
                0f to ring.color.copy(alpha = 0.95f * light),
                0.35f to ring.color.copy(alpha = 0.35f * light),
                1f to Color.Transparent,
                center = nodeCenter,
                radius = radius * 0.075f,
            ),
            radius = radius * 0.075f,
            center = nodeCenter,
        )
    }
}

private fun DrawScope.drawOrbParticles(
    particles: List<OrbitParticle>,
    time: Float,
    center: Offset,
    radius: Float,
    front: Boolean,
) {
    particles.forEach { particle ->
        val isLime = particle.color == VanessaPalette.Lime
        if (isLime != front) return@forEach
        val angle = particle.angle + time * particle.speed
        val x = center.x + cos(angle) * radius * particle.radius
        val y = center.y + sin(angle) * radius * particle.radius * 0.52f
        val twinkle = 0.30f + 0.70f * (0.5f + 0.5f * sin(time * 1.5f + particle.twinkle))
        drawCircle(
            color = particle.color.copy(alpha = 0.55f * twinkle),
            radius = particle.size,
            center = Offset(x, y),
        )
    }
}

/** Completion state for the success screen. Pulses in, then holds. */
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
        style = Stroke(
            width = radius * 0.17f * settle,
            cap = StrokeCap.Round,
            join = StrokeJoin.Round,
        ),
    )
    drawPath(
        path = check,
        color = VanessaPalette.Lime.copy(alpha = settle),
        style = Stroke(
            width = radius * 0.09f * settle,
            cap = StrokeCap.Round,
            join = StrokeJoin.Round,
        ),
    )
}
