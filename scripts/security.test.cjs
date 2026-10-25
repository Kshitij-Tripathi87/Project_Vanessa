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
