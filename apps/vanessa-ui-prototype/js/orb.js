/**
 * Vanessa orb renderer.
 *
 * A glossy, near-black glass sphere — not a flat disc. The body is almost
 * pure black and all the light lives in a thin fresnel rim that wraps the
 * silhouette, plus a tight specular glint and a lime spill in the lower-right.
 * That is what makes it read as a physical object lit from behind rather than
 * a circle with a coloured outline.
 *
 * Each layer is a separate drawing pass so it can move, breathe and react to
 * the interaction state independently:
 *
 *   outer bloom → rings behind → particles behind → body
 *     → inner reflection → cobalt rim (upper-left) → cyan wash
 *     → specular glint → lime spill (lower-right) → hot bottom rim
 *     → glass sheen → rings in front → particles in front
 */

const TAU = Math.PI * 2;

const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

export class Orb {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{ seed?: number, ringCount?: number, particles?: boolean }} [options]
   */
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.seed = options.seed ?? Math.random() * 1000;
    this.ringCount = options.ringCount ?? 3;
    this.particles = options.particles ?? true;

    this.size = 0;
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.time = 0;
    this.energy = 0;          // 0..1 — driven by the interaction state
    this.energyTarget = 0;

    this.particleField = this.#makeParticles(22);
    this.#resize();
  }

  #makeParticles(count) {
    const rand = mulberry32(this.seed);
    return Array.from({ length: count }, () => ({
      angle: rand() * TAU,
      radius: 0.52 + rand() * 0.44,
      speed: (0.04 + rand() * 0.10) * (rand() > 0.5 ? 1 : -1),
      size: 0.5 + rand() * 1.3,
      hue: rand() > 0.80 ? 'lime' : rand() > 0.42 ? 'cyan' : 'blue',
      twinkle: rand() * TAU,
    }));
  }

  #resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const w = Math.round(rect.width * this.dpr);
    const h = Math.round(rect.height * this.dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.size = Math.min(rect.width, rect.height);
  }

  setEnergy(value) {
    this.energyTarget = Math.max(0, Math.min(1, value));
  }

  resize() { this.#resize(); }

  /** @param {number} dt seconds since last frame */
  draw(dt) {
    this.time += dt;
    this.energy += (this.energyTarget - this.energy) * Math.min(1, dt * 4);

    const { ctx, dpr } = this;
    const side = this.size;
    if (!side) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width / dpr, this.canvas.height / dpr);

    const e = this.energy;
    const cx = this.canvas.width / (2 * dpr);
    const cy = this.canvas.height / (2 * dpr);
    // Slow float, matched to the 4–6s spec.
    const bob = Math.sin(this.time * 0.55) * side * 0.010;
    const R = side * 0.345;
    const y = cy + bob;

    const rings = Array.from({ length: this.ringCount }, (_, i) => {
      const phase = this.time * (0.14 + i * 0.045) + this.seed + i * 2.1;
      return {
        rot: -0.34 + i * 0.17 + Math.sin(phase) * 0.06,
        squash: 0.17 + i * 0.075,
        scale: 1.34 + i * 0.16,
        color: i === 1 ? '#35A5FF' : '#2E7BFF',
        alpha: 0.42 - i * 0.08,
        node: i % 2 === 0,
        nodePhase: phase,
      };
    });

    // ── outer bloom: the only light that escapes the silhouette ───────
    const bloomR = R * (1.5 + e * 0.2);
    const bloom = ctx.createRadialGradient(cx, y, R * 0.9, cx, y, bloomR);
    bloom.addColorStop(0, `rgba(7,85,255,${0.14 + e * 0.14})`);
    bloom.addColorStop(0.45, 'rgba(7,85,255,0.045)');
    bloom.addColorStop(1, 'rgba(7,85,255,0)');
    ctx.fillStyle = bloom;
    ctx.beginPath();
    ctx.arc(cx, y, bloomR, 0, TAU);
    ctx.fill();

    this.#drawRings(rings, cx, y, R, false);
    if (this.particles) this.#drawParticles(cx, y, R, 0);

    // ── body: black glass. The centre must stay essentially black. ────
    const body = ctx.createRadialGradient(
      cx - R * 0.26, y - R * 0.30, R * 0.02,
      cx, y, R * 1.0,
    );
    body.addColorStop(0, '#0b111c');
    body.addColorStop(0.38, '#06090f');
    body.addColorStop(0.70, '#03050a');
    body.addColorStop(1, '#010204');
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(cx, y, R, 0, TAU);
    ctx.fill();

    // ── the faintest blue breath just inside the upper-left edge ──────
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, y, R * 0.995, 0, TAU);
    ctx.clip();
    const inner = ctx.createRadialGradient(
      cx - R * 0.62, y - R * 0.64, R * 0.10,
      cx - R * 0.62, y - R * 0.64, R * 0.95,
    );
    inner.addColorStop(0, `rgba(46,123,255,${0.10 + e * 0.07})`);
    inner.addColorStop(0.5, 'rgba(7,45,140,0.030)');
    inner.addColorStop(1, 'rgba(7,45,140,0)');
    ctx.fillStyle = inner;
    ctx.fill();
    ctx.restore();

    // ── cobalt fresnel rim, upper-left (≈8 o'clock → 12:30) ──────────
    this.#rim(ctx, cx, y, R, Math.PI * 0.88, Math.PI * 1.60,
      '#2E7BFF', 0.95 + e * 0.05);

    // ── cyan highlight riding inside that rim ────────────────────────
    this.#rim(ctx, cx, y, R, Math.PI * 1.04, Math.PI * 1.42,
      '#7FC8FF', 0.55 + e * 0.25, { spread: 0.6, core: 0.7 });

    // ── specular glint: tight, hot, upper-left ───────────────────────
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const gx = cx - R * 0.50;
    const gy = y - R * 0.55;
    const spec = ctx.createRadialGradient(gx, gy, 0, gx, gy, R * 0.17);
    spec.addColorStop(0, `rgba(232,246,255,${0.82 + e * 0.18})`);
    spec.addColorStop(0.12, 'rgba(176,224,255,0.52)');
    spec.addColorStop(0.34, 'rgba(70,170,255,0.18)');
    spec.addColorStop(0.68, 'rgba(53,165,255,0.045)');
    spec.addColorStop(1, 'rgba(53,165,255,0)');
    ctx.fillStyle = spec;
    ctx.beginPath();
    ctx.arc(gx, gy, R * 0.17, 0, TAU);
    ctx.fill();
    ctx.restore();

    // ── lime spill, lower-right edge only ────────────────────────────
    this.#rim(ctx, cx, y, R, -Math.PI * 0.06, Math.PI * 0.36,
      '#A8F443', 0.62 + e * 0.30);
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, y, R * 0.99, 0, TAU);
    ctx.clip();
    const lime = ctx.createRadialGradient(
      cx + R * 0.78, y + R * 0.52, 0,
      cx + R * 0.78, y + R * 0.52, R * 0.46,
    );
    lime.addColorStop(0, `rgba(168,244,67,${0.22 + e * 0.16})`);
    lime.addColorStop(0.5, 'rgba(168,244,67,0.05)');
    lime.addColorStop(1, 'rgba(168,244,67,0)');
    ctx.fillStyle = lime;
    ctx.fillRect(cx - R, y - R, R * 2, R * 2);
    ctx.restore();

    // ── hot blue-white bottom rim (≈4:30 → 7:30) ─────────────────────
    this.#rim(ctx, cx, y, R, Math.PI * 0.32, Math.PI * 0.98,
      '#C8E9FF', 0.92);

    // ── glass sheen: barely-there, so the body stays black ────────────
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, y, R * 0.99, 0, TAU);
    ctx.clip();
    ctx.globalCompositeOperation = 'lighter';
    // A radial gradient squashed vertically: an ellipse *filled* with a linear
    // gradient has a hard rim where the fill stops, which shows up as a faint
    // oval on an otherwise black body. This falls to zero well before its own
    // edge, so there is no boundary at all.
    ctx.translate(cx - R * 0.26, y - R * 0.56);
    ctx.rotate(-0.55);
    ctx.scale(1, 0.42);
    const sheenR = R * 0.62;
    const sheen = ctx.createRadialGradient(0, 0, 0, 0, 0, sheenR);
    sheen.addColorStop(0, 'rgba(170,215,255,0.085)');
    sheen.addColorStop(0.45, 'rgba(170,215,255,0.030)');
    sheen.addColorStop(0.75, 'rgba(170,215,255,0.008)');
    sheen.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = sheen;
    ctx.beginPath();
    ctx.arc(0, 0, sheenR, 0, TAU);
    ctx.fill();
    ctx.restore();

    this.#drawRings(rings, cx, y, R, true);
    if (this.particles) this.#drawParticles(cx, y, R, 1);
  }

  /**
   * A fresnel rim across an angular sector.
   *
   * The light is stroked *on* the silhouette rather than filled as a wedge:
   * a clipped radial fill produces a hard radial seam where the sector's edge
   * cuts the gradient, which reads as a geometric slice instead of light.
   *
   * Angular falloff comes from a linear gradient laid along the sector's
   * chord — transparent at both ends, full in the middle — so the rim fades
   * into the dark instead of stopping abruptly. Three stacked strokes give
   * the soft inward falloff: wide bloom, mid glow, hot core.
   */
  #rim(ctx, cx, cy, R, a0, a1, color, alpha, opts = {}) {
    const spread = opts.spread ?? 1;
    const core = opts.core ?? 1;

    const x0 = cx + Math.cos(a0) * R;
    const y0 = cy + Math.sin(a0) * R;
    const x1 = cx + Math.cos(a1) * R;
    const y1 = cy + Math.sin(a1) * R;

    const along = ctx.createLinearGradient(x0, y0, x1, y1);
    along.addColorStop(0, hexToRgba(color, 0));
    along.addColorStop(0.5, hexToRgba(color, alpha));
    along.addColorStop(1, hexToRgba(color, 0));

    const passes = [
      { r: 1.000, w: 0.052 * spread, a: 0.20, blur: 0.34 * spread },
      { r: 0.994, w: 0.020 * spread, a: 0.46, blur: 0.16 * spread },
      { r: 0.987, w: 0.0075, a: 1.00, blur: 0.09 },
    ];

    for (const pass of passes) {
      const a = pass.a * core;
      ctx.save();
      ctx.lineCap = 'round';
      ctx.strokeStyle = along;
      ctx.globalAlpha = a;
      ctx.lineWidth = Math.max(1, R * pass.w);
      ctx.shadowColor = hexToRgba(color, Math.min(1, a * 0.9));
      ctx.shadowBlur = R * pass.blur;
      ctx.beginPath();
      ctx.arc(cx, cy, R * pass.r, a0, a1);
      ctx.stroke();
      ctx.restore();
    }
  }

  #drawRings(rings, cx, cy, R, front) {
    const { ctx } = this;
    for (let i = 0; i < rings.length; i += 1) {
      const ring = rings[i];
      // alternate rings to the two passes so one crosses in front
      if ((i % 2 === 1) !== front) continue;

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(ring.rot);
      ctx.scale(1, ring.squash);

      const alpha = ring.alpha * (front ? 1.25 : 0.75);
      ctx.strokeStyle = hexToRgba(ring.color, alpha);
      ctx.lineWidth = Math.max(0.9, R * 0.010);
      ctx.shadowColor = hexToRgba(ring.color, 0.8);
      ctx.shadowBlur = R * 0.10;
      ctx.beginPath();
      ctx.arc(0, 0, R * ring.scale, 0, TAU);
      ctx.stroke();

      // travelling bright node, like a light catching the ring
      if (ring.node) {
        const a = ring.nodePhase * 0.9;
        const nx = Math.cos(a) * R * ring.scale;
        const ny = Math.sin(a) * R * ring.scale;
        const nodeGrad = ctx.createRadialGradient(nx, ny, 0, nx, ny, R * 0.075);
        nodeGrad.addColorStop(0, hexToRgba(ring.color, 0.95));
        nodeGrad.addColorStop(0.35, hexToRgba(ring.color, 0.35));
        nodeGrad.addColorStop(1, hexToRgba(ring.color, 0));
        ctx.fillStyle = nodeGrad;
        ctx.beginPath();
        ctx.arc(nx, ny, R * 0.075, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  #drawParticles(cx, cy, radius, layer) {
    const { ctx } = this;
    ctx.save();
    for (const p of this.particleField) {
      if ((p.hue === 'lime') !== (layer === 1)) continue;
      const a = p.angle + this.time * p.speed;
      const r = radius * p.radius;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r * 0.52;
      const twinkle = 0.30 + 0.70 * (0.5 + 0.5 * Math.sin(this.time * 1.5 + p.twinkle));
      ctx.fillStyle = hexToRgba(
        p.hue === 'lime' ? '#A8F443' : p.hue === 'cyan' ? '#35A5FF' : '#4C8BFF',
        0.55 * twinkle,
      );
      ctx.shadowColor = p.hue === 'lime' ? 'rgba(168,244,67,0.8)' : 'rgba(53,165,255,0.8)';
      ctx.shadowBlur = 5;
      ctx.beginPath();
      ctx.arc(x, y, p.size, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }
}

/* ── helpers ──────────────────────────────────────────────────── */

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hexToRgba(hex, alpha) {
  const value = hex.replace('#', '');
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

export { easeInOut };
