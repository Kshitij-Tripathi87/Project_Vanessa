// This fixed program receives data only through JSON, never executable shell text.
const { spawnSync } = require('node:child_process');
try {
  const request = JSON.parse(process.env.VANESSA_CODEX_REQUEST);
  delete process.env.VANESSA_CODEX_REQUEST;
  const result = spawnSync(request.file, request.args, {
    cwd: request.projectPath,
    stdio: 'inherit',
    shell: false,
    windowsHide: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error(`Codex exited with ${result.status ?? result.signal}.`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`Codex launch failed: ${error.message}`);
  process.exitCode = 1;
}
