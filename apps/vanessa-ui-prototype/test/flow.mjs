/**
 * Flow test: exercises the real user journey
 * chat intent -> confirm -> approve -> executing -> success
 */
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(`${ROOT}/index.html`, 'utf8');
const errors = [];
const dom = new JSDOM(html, { url: 'http://localhost:8080/', pretendToBeVisual: true });
const { window } = dom;

const CTX_METHODS = ['arc','beginPath','clearRect','clip','ellipse','fill','fillRect','lineTo','moveTo','restore','rotate','save','scale','setLineDash','setTransform','stroke','translate','closePath','rect','quadraticCurveTo','bezierCurveTo'];
function makeCtx() {
  const ctx = {};
  for (const m of CTX_METHODS) ctx[m] = () => {};
  ctx.createLinearGradient = () => ({ addColorStop() {} });
  ctx.createRadialGradient = () => ({ addColorStop() {} });
  return ctx;
}
function patchCanvas(canvas) {
  canvas.getContext = () => makeCtx();
  Object.defineProperty(canvas, 'width', { value: 800, writable: true, configurable: true });
  Object.defineProperty(canvas, 'height', { value: 600, writable: true, configurable: true });
  canvas.getBoundingClientRect = () => ({ width: 400, height: 400, top: 0, left: 0, right: 400, bottom: 400, x: 0, y: 0 });
}

globalThis.window = window;
globalThis.document = window.document;
try { Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true }); } catch {}
globalThis.HTMLElement = window.HTMLElement;
globalThis.Element = window.Element;
globalThis.Node = window.Node;
globalThis.NodeList = window.NodeList;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.devicePixelRatio = 2;

window.devicePixelRatio = 2;
window.innerWidth = 430;
window.innerHeight = 900;
window.matchMedia = (q) => ({ matches: false, media: q, addEventListener(){}, removeEventListener(){}, addListener(){}, removeListener(){} });
window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16);
window.cancelAnimationFrame = (id) => clearTimeout(id);
window.document.fonts = { ready: Promise.resolve(), addEventListener(){}, check: () => true };
globalThis.requestAnimationFrame = window.requestAnimationFrame;
globalThis.cancelAnimationFrame = window.cancelAnimationFrame;

window.document.querySelectorAll('canvas').forEach(patchCanvas);

const onErr = (e) => errors.push('ERROR: ' + (e?.message || e?.error?.message || e?.reason?.message || String(e)));
process.on('uncaughtException', onErr);
process.on('unhandledRejection', onErr);
window.addEventListener('error', onErr);
window.addEventListener('unhandledrejection', onErr);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await import(pathToFileURL(`${ROOT}/js/app.js`).href);
await sleep(300);

const q = (s) => window.document.querySelector(s);
const qa = (s) => [...window.document.querySelectorAll(s)];
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const active = () => qa('[data-screen].is-active').map(e => e.dataset.screen).join(',') || '(none)';

function expect(cond, msg) { if (!cond) errors.push('FAIL: ' + msg); else console.log('  ok  ' + msg); }

console.log('boot active:', active());

/* 1. welcome -> onboarding -> permissions -> chat */
for (const s of ['onboarding', 'permissions', 'chat']) {
  const b = q(`[data-go="${s}"]`);
  expect(!!b, `nav button for "${s}" exists`);
  if (b) { click(b); await sleep(150); }
  expect(active().includes(s), `reached "${s}" (active: ${active()})`);
}

/* 2. type a destructive intent from the chat composer */
const input = q('[data-screen="chat"] input, [data-screen="chat"] textarea');
const send = q('#send');
expect(!!input && !!send, 'chat composer is present');

input.value = 'delete 3 incomplete project folders';
input.dispatchEvent(new window.Event('input', { bubbles: true }));
click(send);
await sleep(2600);

const bubbleText = qa('[data-screen="chat"] .bubble, [data-screen="chat"] .msg')
  .map(n => n.textContent.trim()).join(' | ');
console.log('  chat log:', bubbleText.slice(0, 200));

expect(active().includes('confirm'), `destructive intent routes to confirm (active: ${active()})`);
const confirmCopy = q('[data-screen="confirm"]')?.textContent || '';
expect(/delete 3 incomplete project folders/i.test(confirmCopy), 'confirm screen states the exact action');
expect(!!q('[data-screen="confirm"] [data-confirm]'), 'Approve button exists');

/* 3. approve -> executing autoplays -> success */
click(q('[data-screen="confirm"] [data-confirm]'));
await sleep(250);
expect(active().includes('executing'), `approve starts execution (active: ${active()})`);

const stepStates = () => qa('#steps .step').map(s => s.dataset.state).join(',');
console.log('  step states @0.3s:', stepStates());
await sleep(2200);
console.log('  step states @2.5s:', stepStates());
const mid = qa('#steps .step').map(s => s.dataset.state);
expect(mid.includes('done') || mid.includes('active'), 'stepper is progressing');

/* wait out the full stepper (3 steps x ~1.15s + 0.6s lead + 0.52s) */
await sleep(5000);
expect(active().includes('success'), `execution completes into success (active: ${active()})`);
const successCopy = q('[data-screen="success"]')?.textContent || '';
expect(/All set!/i.test(successCopy), 'success screen shows "All set!"');
expect(/Your request is complete/i.test(successCopy), 'success screen shows completion copy');

console.log('\nerrors:', errors.length);
for (const e of errors) console.log('  -', e);
process.exit(errors.length ? 1 : 0);
