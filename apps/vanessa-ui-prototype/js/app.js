/**
 * Vanessa UI prototype — controller.
 *
 * Responsibilities:
 *  - screen navigation with history and gesture support
 *  - an interaction-state machine (idle / listening / thinking / speaking)
 *    that drives orb energy, so the orb reacts to what Vanessa is doing
 *  - a scripted chat flow used to demo confirm → execute → success
 *  - a single rAF loop for every canvas so nothing drifts out of sync
 */

import { Orb } from './orb.js';
import { Waveform, ProgressArcs } from './waves.js';

/* ── Boot ───────────────────────────────────────────────────── */

const screens = new Map();
document.querySelectorAll('[data-screen]').forEach((el) => {
  screens.set(el.dataset.screen, el);
});

const orbs = [];
document.querySelectorAll('.orb-canvas').forEach((canvas, i) => {
  orbs.push({ canvas, orb: new Orb(canvas, { seed: 120 + i * 37, ringCount: i % 2 === 0 ? 3 : 2 }) });
});

const waves = [];
document.querySelectorAll('.wave-canvas').forEach((canvas, i) => {
  const mode = canvas.dataset.waves;
  const intensity = mode === 'foot' || mode === 'ambient' ? 0.55 : 1;
  waves.push({ canvas, wave: new Waveform(canvas, { intensity, seed: i * 1.9 }) });
});

const arcsCanvas = document.getElementById('progress-arcs');
const arcs = arcsCanvas ? new ProgressArcs(arcsCanvas) : null;

/* ── Interaction state ──────────────────────────────────────── */

const STATE = {
  idle: 0.12,
  listening: 0.95,
  thinking: 0.6,
  speaking: 0.75,
  success: 0.4,
};

let state = 'idle';

function setState(next) {
  state = next;
  const energy = STATE[next] ?? STATE.idle;
  orbs.forEach(({ orb }) => orb.setEnergy(energy));
  if (arcs) arcs.setProgress(next === 'success' ? 1 : 0.42);
}

/* ── Navigation ─────────────────────────────────────────────── */

const history = ['welcome'];
let current = 'welcome';

function show(name, { push = true } = {}) {
  if (!screens.has(name) || name === current) return;

  const from = screens.get(current);
  const to = screens.get(name);

  from.classList.remove('is-active');
  from.classList.add('is-leaving');
  window.setTimeout(() => from.classList.remove('is-leaving'), 420);

  // Scroll the incoming screen to the top so long screens never open mid-way.
  to.scrollTop = 0;
  to.classList.add('is-active');

  if (push) history.push(name);
  current = name;

  onEnter(name);
  syncDots(name);
}

function onEnter(name) {
  switch (name) {
    case 'chat':
      setState('idle');
      ensureGreeting();
      break;
    case 'listening':
      setState('listening');
      break;
    case 'executing':
      setState('thinking');
      runExecution();
      break;
    case 'success':
      setState('success');
      break;
    case 'confirm':
      setState('thinking');
      break;
    default:
      setState('idle');
  }
  // The device frame may change size between screens; re-measure canvases.
  requestAnimationFrame(measureAll);
}

document.addEventListener('click', (event) => {
  const goBtn = event.target.closest('[data-go]');
  if (goBtn) {
    event.preventDefault();
    show(goBtn.dataset.go);
    return;
  }

  const listenBtn = event.target.closest('[data-listen]');
  if (listenBtn) {
    show('listening');
    return;
  }

  const confirmBtn = event.target.closest('[data-confirm]');
  if (confirmBtn) {
    show('executing');
    return;
  }

  const toggle = event.target.closest('.toggle');
  if (toggle) {
    const on = toggle.classList.toggle('is-on');
    toggle.setAttribute('aria-checked', String(on));
  }
});

/* Hardware/browser back button support */
window.addEventListener('popstate', () => {
  if (history.length > 1) {
    history.pop();
    show(history[history.length - 1], { push: false });
  }
});

/* Swipe up on the welcome screen */
let touchStartY = null;
document.addEventListener('touchstart', (e) => {
  touchStartY = e.touches[0]?.clientY ?? null;
}, { passive: true });
document.addEventListener('touchend', (e) => {
  if (touchStartY == null || current !== 'welcome') return;
  const endY = e.changedTouches[0]?.clientY ?? touchStartY;
  if (touchStartY - endY > 60) show('onboarding');
  touchStartY = null;
}, { passive: true });

/* ── Onboarding dots ────────────────────────────────────────── */

const dotsWrap = document.querySelector('[data-dots]');
if (dotsWrap) {
  const count = Number(dotsWrap.dataset.dots || 3);
  dotsWrap.innerHTML = Array.from({ length: count }, (_, i) =>
    `<i${i === 0 ? ' class="is-on"' : ''}></i>`).join('');
}
function syncDots(name) {
  if (!dotsWrap) return;
  const index = { onboarding: 0, permissions: 1, chat: 2 }[name];
  [...dotsWrap.children].forEach((dot, i) => dot.classList.toggle('is-on', i === index));
}

/* ── Chat ───────────────────────────────────────────────────── */

const thread = document.getElementById('thread');
const composer = document.getElementById('composer');
const input = document.getElementById('message');

function el(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild;
}

function addUser(text) {
  const node = el(`<p class="msg msg--user">${escapeHtml(text)}</p>`);
  thread.appendChild(node);
  scrollChat();
}

function addBot(text) {
  const node = el(`<div class="row row--bot"><p class="msg msg--bot">${escapeHtml(text)}</p></div>`);
  thread.appendChild(node);
  scrollChat();
  return node;
}

function addAction({ icon = 'mail', label, state: actionState = 'busy' }) {
  const trailing = actionState === 'done'
    ? '<span class="action__tick"><svg><use href="#i-check"/></svg></span>'
    : '<span class="spinner" role="status" aria-label="Working"></span>';
  const node = el(`
    <div class="action">
      <svg><use href="#i-${icon}"/></svg>
      <span class="action__label">${escapeHtml(label)}</span>
      ${trailing}
    </div>`);
  thread.appendChild(node);
  scrollChat();
  return node;
}

function scrollChat() {
  const scroller = document.getElementById('chat-scroll');
  if (scroller) scroller.scrollTop = scroller.scrollHeight;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

let greeted = false;
function ensureGreeting() {
  if (greeted || !thread) return;
  greeted = true;
  window.setTimeout(() => addBot('Good evening. What should we get done?'), 220);
}

const wait = (ms) => new Promise((r) => window.setTimeout(r, ms));

async function respondTo(text) {
  const lower = text.toLowerCase();
  setState('thinking');
  await wait(420);

  if (/email|mail|outlook|inbox/.test(lower)) {
    addBot('Sure, checking your emails now.');
    await wait(520);
    const task = addAction({ icon: 'mail', label: 'Opening Outlook' });
    setState('speaking');
    await wait(1500);
    task.replaceChildren(
      el('<svg><use href="#i-mail"/></svg>'),
      el('<span class="action__label">Opening Outlook</span>'),
      el('<span class="action__tick"><svg><use href="#i-check"/></svg></span>'),
    );
    await wait(420);
    addBot('Outlook is open. Three unread threads need a reply.');
  } else if (/delete|remove|clean|folder|tidy|organi[sz]e/.test(lower)) {
    addBot('I can do that. It needs your approval first.');
    await wait(560);
    show('confirm');
    return;
  } else if (/calendar|day|schedule|meeting/.test(lower)) {
    addBot('Reading your calendar.');
    await wait(620);
    addAction({ icon: 'calendar', label: 'Reading calendar', state: 'done' });
    addBot('You have two meetings this afternoon: 14:00 standup, 16:30 design review.');
  } else if (/hi|hello|hey/.test(lower)) {
    addBot('Hello. Ask me to check your email, tidy a folder, or read your calendar.');
  } else {
    addBot('I can check your email, organise folders, or read your calendar. Try one of those.');
  }

  setState('idle');
}

if (composer) {
  composer.addEventListener('submit', (event) => {
    event.preventDefault();
    send();
  });
}

function send() {
  const text = (input?.value || '').trim();
  if (!text) return;
  input.value = '';
  addUser(text);
  respondTo(text);
}

document.getElementById('send')?.addEventListener('click', (event) => {
  event.preventDefault();
  send();
});

/* ── Executing → success flow ───────────────────────────────── */

let executionTimer = null;

async function runExecution() {
  const steps = [...document.querySelectorAll('#steps .step')];
  if (!steps.length) return;

  steps.forEach((step, i) => {
    step.dataset.state = i === 0 ? 'active' : i === 2 ? 'queued' : 'queued';
  });
  window.clearTimeout(executionTimer);

  const advance = async () => {
    for (let i = 0; i < steps.length; i += 1) {
      steps[i].dataset.state = 'active';
      if (arcs) arcs.setProgress((i + 0.35) / steps.length);
      await wait(1150);
      steps[i].dataset.state = 'done';
      if (arcs) arcs.setProgress((i + 1) / steps.length);
    }
    await wait(520);
    if (current === 'executing') show('success');
  };

  executionTimer = window.setTimeout(advance, 600);
}

/* ── Render loop ────────────────────────────────────────────── */

function measureAll() {
  orbs.forEach(({ orb }) => orb.resize());
  waves.forEach(({ wave }) => wave.resize());
  arcs?.resize();
}

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

let last = performance.now();
function frame(now) {
  // Clamp dt so tab-switching never produces a huge jump in the animation.
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  if (!reduceMotion.matches) {
    orbs.forEach(({ orb }) => orb.draw(dt));
    waves.forEach(({ wave }) => wave.draw(dt));
    arcs?.draw(dt);
  }
  requestAnimationFrame(frame);
}

/* Static render for reduced-motion users so canvases aren't blank. */
function renderOnce() {
  orbs.forEach(({ orb }) => orb.draw(0.016));
  waves.forEach(({ wave }) => wave.draw(0.016));
  arcs?.draw(0.016);
}

/* ── Ambient particles ──────────────────────────────────────── */

const ambientCanvas = document.getElementById('ambient-canvas');
const ambientCtx = ambientCanvas?.getContext('2d');
let ambientDots = [];

function seedAmbient() {
  const count = window.innerWidth < 640 ? 26 : 46;
  ambientDots = Array.from({ length: count }, () => ({
    x: Math.random(),
    y: Math.random(),
    r: 0.5 + Math.random() * 1.4,
    vy: 0.004 + Math.random() * 0.012,
    hue: Math.random() > 0.82 ? '168,244,67' : Math.random() > 0.45 ? '53,165,255' : '7,85,255',
    tw: Math.random() * Math.PI * 2,
  }));
}

function drawAmbient(t) {
  if (!ambientCtx) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = ambientCanvas.clientWidth;
  const h = ambientCanvas.clientHeight;
  if (ambientCanvas.width !== w * dpr || ambientCanvas.height !== h * dpr) {
    ambientCanvas.width = w * dpr;
    ambientCanvas.height = h * dpr;
  }
  ambientCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ambientCtx.clearRect(0, 0, w, h);

  for (const dot of ambientDots) {
    dot.y -= dot.vy * 0.01;
    if (dot.y < -0.05) dot.y = 1.05;
    const alpha = 0.25 + 0.55 * (0.5 + 0.5 * Math.sin(t * 0.0014 + dot.tw));
    ambientCtx.fillStyle = `rgba(${dot.hue},${alpha * 0.7})`;
    ambientCtx.beginPath();
    ambientCtx.arc(dot.x * w, dot.y * h, dot.r, 0, Math.PI * 2);
    ambientCtx.fill();
  }
}

function ambientFrame(t) {
  if (!reduceMotion.matches) drawAmbient(t);
  requestAnimationFrame(ambientFrame);
}

/* ── Lifecycle ──────────────────────────────────────────────── */

window.addEventListener('resize', () => {
  measureAll();
  seedAmbient();
  if (reduceMotion.matches) renderOnce();
});

// Re-measure once fonts settle, otherwise canvas sizing can be off by a frame.
document.fonts?.ready.then(measureAll);
window.addEventListener('load', measureAll);

/* Clock in the status bar (prototype nicety, mirrors a real device) */
const clock = document.getElementById('clock');
function tickClock() {
  if (!clock) return;
  const now = new Date();
  clock.textContent = `${now.getHours() % 12 || 12}:${String(now.getMinutes()).padStart(2, '0')}`;
}
tickClock();
window.setInterval(tickClock, 30000);

/* Greeting matches time of day */
const greeting = document.getElementById('greeting');
if (greeting) {
  const hour = new Date().getHours();
  greeting.textContent = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}

seedAmbient();
setState('idle');
requestAnimationFrame(measureAll);

if (reduceMotion.matches) {
  renderOnce();
} else {
  requestAnimationFrame(frame);
  requestAnimationFrame(ambientFrame);
}

reduceMotion.addEventListener?.('change', () => {
  if (reduceMotion.matches) renderOnce();
});
