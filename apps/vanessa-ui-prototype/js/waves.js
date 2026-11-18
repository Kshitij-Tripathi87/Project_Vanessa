/**
 * Flowing N-waveform renderer (design spec §4).
 *
 * Deliberately NOT an equaliser: these are overlapping luminous ribbons on
 * smooth sine curves with differing amplitudes and phases. Layers are drawn
 * back-to-front (dark navy → blue → cyan → lime) so the composite reads as
 * illuminated energy suspended in space rather than stacked bars.
 */

const TAU = Math.PI * 2;

const LAYERS = [
  { color: '#0B2A6B', width: 0.030, amp: 0.92, freq: 1.05, speed: 0.16, alpha: 0.55, glow: 0 },
  { color: '#0755FF', width: 0.020, amp: 0.74, freq: 1.35, speed: 0.24, alpha: 0.95, glow: 0.9 },
  { color: '#35A5FF', width: 0.014, amp: 0.56, freq: 1.65, speed: -0.30, alpha: 0.85, glow: 0.7 },
  { color: '#A8F443', width: 0.012, amp: 0.40, freq: 1.95, speed: 0.36, alpha: 0.80, glow: 0.8 },
];

export class Waveform {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{ intensity?: number, seed?: number }} [options]
   */
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.intensity = options.intensity ?? 1;
    this.seed = options.seed ?? Math.random() * 10;
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.time = 0;
    this.w = 0;
    this.h = 0;
    this.#resize();
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
    this.w = rect.width;
    this.h = rect.height;
  }

  resize() { this.#resize(); }

  draw(dt) {
    this.time += dt;
    const { ctx } = this;
    const { w, h } = this;
    if (!w || !h) return;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const midY = h * 0.52;
    const step = Math.max(2, w / 220);

    // Soft reflection beneath the ribbons. A plain fillRect shows its own
    // left/right edges as a hard rectangle on a dark screen, and masking it
    // with `destination-in` would be worse: that operator clears the whole
    // canvas outside the mask, wiping the ribbons too. A radial gradient
    // reaches zero in every direction on its own, with no compositing.
    ctx.save();
    ctx.translate(w * 0.5, midY + h * 0.12);
    ctx.scale(1, 0.55);
    const floorR = w * 0.56;
    const floor = ctx.createRadialGradient(0, 0, 0, 0, 0, floorR);
    floor.addColorStop(0, 'rgba(7,85,255,0.10)');
    floor.addColorStop(0.4, 'rgba(7,85,255,0.045)');
    floor.addColorStop(0.72, 'rgba(7,85,255,0.012)');
    floor.addColorStop(1, 'rgba(7,85,255,0)');
    ctx.fillStyle = floor;
    ctx.beginPath();
    ctx.arc(0, 0, floorR, 0, TAU);
    ctx.fill();
    ctx.restore();

    for (const layer of LAYERS) {
      this.#ribbon(layer, midY, step);
    }
  }

  #ribbon(layer, midY, step) {
    const { ctx } = this;
    const { w, h } = this;
    const amplitude = h * 0.34 * layer.amp * this.intensity;
    const k = (TAU * layer.freq) / w;
    const phase = this.time * layer.speed * TAU * 0.28 + this.seed;

    const yAt = (x) => {
      // Two superposed sines give the organic, non-repeating N shape.
      const primary = Math.sin(x * k + phase);
      const secondary = Math.sin(x * k * 2.37 - phase * 1.6) * 0.34;
      const envelope = 0.72 + 0.28 * Math.sin((x / w) * Math.PI);
      return midY + (primary + secondary) * amplitude * 0.5 * envelope;
    };

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = hexToRgba(layer.color, layer.alpha);
    ctx.lineWidth = Math.max(1.2, h * layer.width);
    if (layer.glow) {
      ctx.shadowColor = hexToRgba(layer.color, 0.85);
      ctx.shadowBlur = h * 0.22 * layer.glow;
    }

    ctx.beginPath();
    for (let x = 0; x <= w; x += step) {
      const y = yAt(x);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Thin bright core on the topmost layers for the "luminous edge" look.
    if (layer.glow >= 0.7) {
      ctx.shadowBlur = 0;
      ctx.strokeStyle = hexToRgba('#DFF3FF', 0.34);
      ctx.lineWidth = Math.max(0.6, h * layer.width * 0.32);
      ctx.stroke();
    }
    ctx.restore();
  }
}

/**
 * Circular progress arcs for the "Executing Task" screen.
 * Two flat arcs — cobalt on the lower-left, lime on the upper-right — driven
 * by an explicit progress value. No percentage text, no fake precision.
 */
export class ProgressArcs {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.progress = 0;
    this.target = 0.42;
    this.time = 0;
    this.#resize();
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
    this.w = rect.width;
    this.h = rect.height;
  }

  resize() { this.#resize(); }

  setProgress(value) {
    this.target = Math.max(0, Math.min(1, value));
  }

  draw(dt) {
    this.time += dt;
    this.progress += (this.target - this.progress) * Math.min(1, dt * 2.2);

    const { ctx, w, h } = this;
    if (!w || !h) return;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const cx = w / 2;
    const cy = h / 2;
    const radius = Math.min(w, h) * 0.455;

    // inactive track
    ctx.save();
    ctx.strokeStyle = 'rgba(185,197,218,0.16)';
    ctx.lineWidth = Math.max(2, radius * 0.035);
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, TAU);
    ctx.stroke();
    ctx.restore();

    // cobalt arc: lower-left sweep
    this.#arc(cx, cy, radius, Math.PI * 0.55, Math.PI * 0.55 + Math.PI * 0.95, '#0755FF', '#35A5FF');

    // lime arc: upper-right + trailing dot
    const limeStart = Math.PI * 1.62;
    const limeEnd = limeStart + Math.PI * 1.15;
    this.#arc(cx, cy, radius, limeStart, limeEnd, '#A8F443', '#D4FF8F');

    // slow rotating accent tick
    const tickA = this.time * 0.9;
    ctx.save();
    ctx.fillStyle = 'rgba(53,165,255,0.95)';
    ctx.shadowColor = 'rgba(53,165,255,0.95)';
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(cx + Math.cos(tickA) * radius, cy + Math.sin(tickA) * radius, Math.max(1.6, radius * 0.022), 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  #arc(cx, cy, radius, start, end, colorOuter, colorInner) {
    const { ctx } = this;
    ctx.save();
    ctx.lineCap = 'round';
    const grad = ctx.createLinearGradient(cx - radius, cy - radius, cx + radius, cy + radius);
    grad.addColorStop(0, colorOuter);
    grad.addColorStop(1, colorInner);
    ctx.strokeStyle = grad;
    ctx.lineWidth = Math.max(2.4, radius * 0.05);
    ctx.shadowColor = colorOuter;
    ctx.shadowBlur = radius * 0.22;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, start, end);
    ctx.stroke();
    ctx.restore();
  }
}

/* Matches orb.js helper so both renderers speak the same colour language. */
export function hexToRgba(hex, alpha) {
  const value = hex.replace('#', '');
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
