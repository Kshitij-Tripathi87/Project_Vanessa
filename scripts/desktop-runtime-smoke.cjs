/* Sandbox-only Electron runtime probe. Synthetic data only; never sends a task or provider request. */
const WebSocket = require('ws');

function evaluateInRenderer(debuggerUrl, expression, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = new WebSocket(debuggerUrl);
    const timer = setTimeout(() => finish(new Error('Electron renderer probe timed out.')), timeoutMs);
    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else resolve(result);
    }
    socket.once('open', () => socket.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true },
    })));
    socket.on('message', (data) => {
      let message;
      try { message = JSON.parse(data.toString()); } catch { return; }
      if (message.id !== 1) return;
      if (message.error || message.result?.exceptionDetails) {
        return finish(new Error('Electron renderer probe failed; inspect renderer diagnostics.'));
      }
      finish(null, message.result?.result?.value);
    });
    socket.once('error', () => finish(new Error('Could not connect to the Electron renderer probe.')));
    socket.once('close', () => finish(new Error('Electron renderer probe closed before replying.')));
  });
}

// The script runs only in an isolated --runtime-smoke user-data directory.
// Its saved state is synthetic and is explicitly cleared by the second launch.
function historyProbeExpression(phase, checkVoice, built) {
  if (!['write', 'verify'].includes(phase)) throw new Error('Invalid runtime smoke phase.');
  return `(async () => {
    const waitUntil = async (check, label) => {
      const deadline = Date.now() + 9000;
      while (Date.now() < deadline) {
        if (check()) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(label + ' did not become ready');
    };
    await waitUntil(() => document.querySelector('.orb-button') && window.vanessa?.loadConversationHistory, 'Desktop UI');
    if (${JSON.stringify(built)}) {
      const response = await fetch('vanessa://desktop/index.html');
      const csp = response.headers.get('content-security-policy') || '';
      if (!response.ok || !csp.includes("script-src 'self'") || csp.includes('https://unpkg.com')) throw new Error('Built renderer security policy unavailable');
    }
    const loaded = await window.vanessa.loadConversationHistory();
    if (!loaded.ok) throw new Error('OS-backed conversation storage unavailable');
    const expected = 'Synthetic desktop persistence smoke test';
    if (${JSON.stringify(phase)} === 'write') {
      if (loaded.revision !== 0 || loaded.state !== null) throw new Error('Smoke profile was not empty');
      const state = {
        conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', status: 'active', activeTurnId: null,
        turns: [{
          turnId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          requestId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          role: 'user', source: 'text', text: expected, final: true, streaming: false, status: 'completed', createdAt: 42,
        }],
      };
      const saved = await window.vanessa.saveConversationHistory(state, 0);
      if (!saved.ok || saved.revision !== 1) throw new Error('Synthetic snapshot was not saved');
    } else {
      if (loaded.revision !== 1 || loaded.state?.turns?.[0]?.text !== expected) throw new Error('Synthetic snapshot did not survive restart');
      const expand = document.querySelector('.orb-expand');
      if (!expand) throw new Error('Desktop panel control unavailable');
      expand.click();
      await waitUntil(() => document.body.textContent.includes(expected), 'Restored conversation');
      const cleared = await window.vanessa.clearConversationHistory(1);
      if (!cleared.ok || cleared.revision !== 0) throw new Error('Synthetic snapshot could not be cleared');
      const after = await window.vanessa.loadConversationHistory();
      if (!after.ok || after.state !== null || after.revision !== 0) throw new Error('Synthetic snapshot still exists after clear');
    }
    if (${JSON.stringify(checkVoice)}) {
      await new Promise((resolve, reject) => {
        const socket = new WebSocket('ws://127.0.0.1:4500/ws');
        const timer = setTimeout(() => { socket.close(); reject(new Error('Local voice session was not ready')); }, 4000);
        socket.onmessage = (event) => {
          try {
            if (JSON.parse(event.data).type === 'session_ready') { clearTimeout(timer); socket.close(); resolve(); }
          } catch {}
        };
        socket.onerror = () => { clearTimeout(timer); reject(new Error('Local voice socket failed')); };
        socket.onclose = (event) => { if (event.code === 1008) { clearTimeout(timer); reject(new Error('Voice origin was rejected')); } };
      });
    }
    return true;
  })()`;
}

async function runHistoryProbe(debuggerUrl, phase, checkVoice, built) {
  const result = await evaluateInRenderer(debuggerUrl, historyProbeExpression(phase, checkVoice, built));
  if (result !== true) throw new Error('Electron renderer probe returned an invalid result.');
}

module.exports = { evaluateInRenderer, historyProbeExpression, runHistoryProbe };
