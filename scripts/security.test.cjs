const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? files(file) : [file];
  });
}

test('renderer build contains no provider credential access or security canary', () => {
  const output = path.join(root, 'apps/desktop/dist/renderer');
  assert(fs.existsSync(output), 'Build the desktop before checking the renderer boundary.');
  for (const file of files(output)) {
    const content = fs.readFileSync(file, 'utf8');
    assert(!/SARVAM_API_KEY|FISH_API_KEY|GEMINI_API_KEY|api-subscription-key|vanessa-build-secret-canary/.test(content), 'Provider credential material must not enter the renderer.');
  }
});

test('private environment and memory files are not tracked', () => {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0');
  assert(!tracked.some(file => /(^|\/)\.env$|(^|\/)\.env\.local$|vanessa_memory_palace\.db/.test(file)), 'Private runtime files must remain untracked.');
});

// Exercise the emitted production worklet, where asset inlining previously
// hid raw TypeScript behind a CSP-blocked data:video/mp2t URL.
test('microphone worklet is emitted as executable JavaScript and referenced by the renderer', () => {
  const vm = require('node:vm');
  const output = path.join(root, 'apps/desktop/dist/renderer');
  const emitted = files(output);
  const worklet = emitted.find(file => /pcmCapture\.worklet-[^/\\]+\.js$/.test(file));
  assert(worklet, 'The worklet must be compiled to a separate JavaScript file.');
  const name = path.basename(worklet);
  assert(emitted.some(file => file !== worklet && file.endsWith('.js') && fs.readFileSync(file, 'utf8').includes(name)), 'The renderer must reference the compiled worklet URL.');
  let Processor;
  let posted;
  vm.runInNewContext(fs.readFileSync(worklet, 'utf8'), {
    AudioWorkletProcessor: class { port = { postMessage(samples) { posted = samples; } }; },
    registerProcessor(id, implementation) { assert.equal(id, 'vanessa-pcm-capture'); Processor = implementation; },
    Float32Array,
  });
  assert(Processor);
  const samples = new Float32Array([0.25, -0.5, 0.75]);
  const mutedOutput = new Float32Array([1, 1, 1]);
  assert.equal(new Processor().process([[samples]], [[mutedOutput]]), true);
  assert.deepEqual(posted, samples);
  assert.notEqual(posted, samples, 'Transfer a copy so the input audio buffer remains usable.');
  assert.deepEqual([...mutedOutput], [0, 0, 0]);
});
