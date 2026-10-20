export function getRemotePwaHtml(port: number, defaultPairingCode: string = "482913", defaultDeviceName: string = "Kshitij-Laptop"): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Vanessa Mobile Companion</title>
  <style>
    :root {
      --bg: #07090e;
      --card-bg: rgba(18, 24, 38, 0.7);
      --card-border: rgba(0, 242, 254, 0.2);
      --cyan: #00f2fe;
      --cyan-glow: rgba(0, 242, 254, 0.4);
      --green: #10b981;
      --amber: #f59e0b;
      --red: #f43f5e;
      --text-main: #f1f5f9;
      --text-muted: #94a3b8;
    }
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      -webkit-tap-highlight-color: transparent;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text-main);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      overflow-x: hidden;
      padding-bottom: 30px;
    }
    .header {
      padding: 16px 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(11, 15, 25, 0.9);
      backdrop-filter: blur(10px);
      position: sticky;
      top: 0;
      z-index: 50;
    }
    .logo {
      font-size: 16px;
      font-weight: 700;
      letter-spacing: 0.06em;
      color: #fff;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .badge {
      font-size: 11px;
      padding: 3px 8px;
      border-radius: 12px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 5px;
    }
    .badge-online {
      background: rgba(16, 185, 129, 0.15);
      color: var(--green);
      border: 1px solid rgba(16, 185, 129, 0.3);
    }
    .badge-paired {
      background: rgba(0, 242, 254, 0.15);
      color: var(--cyan);
      border: 1px solid rgba(0, 242, 254, 0.3);
    }
    .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: currentColor;
      box-shadow: 0 0 8px currentColor;
    }
    .container {
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 16px;
      flex: 1;
    }
    .glass-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 14px;
      padding: 18px;
      backdrop-filter: blur(12px);
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
    }
    .pairing-box {
      display: flex;
      flex-direction: column;
      gap: 14px;
      margin-top: 10px;
    }
    .input-field {
      padding: 12px 14px;
      border-radius: 8px;
      background: rgba(0, 0, 0, 0.4);
      border: 1px solid var(--card-border);
      color: #fff;
      font-size: 14px;
      outline: none;
    }
    .code-input {
      font-size: 24px;
      font-weight: 800;
      letter-spacing: 6px;
      text-align: center;
      padding: 12px;
      border-radius: 10px;
      background: rgba(0, 0, 0, 0.4);
      border: 1px solid var(--cyan);
      color: var(--cyan);
      outline: none;
      font-family: monospace;
    }
    .btn {
      padding: 14px 20px;
      border-radius: 10px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      border: none;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      transition: all 0.2s ease;
    }
    .btn-primary {
      background: linear-gradient(135deg, #00f2fe 0%, #0284c7 100%);
      color: #08090d;
      box-shadow: 0 4px 15px var(--cyan-glow);
    }
    .btn-approve {
      background: linear-gradient(135deg, #10b981 0%, #059669 100%);
      color: #ffffff;
      flex: 2;
    }
    .btn-deny {
      background: rgba(244, 63, 94, 0.15);
      border: 1px solid rgba(244, 63, 94, 0.3);
      color: #fda4af;
      flex: 1;
    }
    .chip {
      padding: 9px 12px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 10px;
      font-size: 12px;
      color: var(--text-muted);
      cursor: pointer;
      text-align: left;
      line-height: 1.4;
    }
    .chip:active {
      background: rgba(0, 242, 254, 0.15);
      color: var(--cyan);
    }
    .timeline-item {
      display: flex;
      gap: 12px;
      margin-bottom: 10px;
      font-size: 13px;
    }
    .timeline-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--cyan);
      margin-top: 4px;
      flex-shrink: 0;
    }
    .result-link {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px;
      background: rgba(0, 242, 254, 0.08);
      border: 1px solid var(--cyan);
      border-radius: 8px;
      margin-top: 10px;
      word-break: break-all;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="logo">
      <div style="width: 8px; height: 8px; border-radius: 50%; background: var(--cyan); box-shadow: 0 0 10px var(--cyan);"></div>
      VANESSA <span style="color: var(--cyan); font-weight: 400">// REMOTE</span>
    </div>
    <div id="statusBadge" class="badge badge-paired">
      <div class="dot"></div>
      <span id="statusText">Paired: ${defaultDeviceName}</span>
    </div>
  </div>

  <div class="container">
    <!-- Device Name & 6-Digit Code Pairing Screen (Toggleable) -->
    <div id="pairingView" class="glass-card pairing-box" style="display: none;">
      <h2 style="font-size: 17px; color: #fff;">Pair with Laptop Vanessa</h2>
      <p style="font-size: 12px; color: var(--text-muted); line-height: 1.5;">
        Enter your laptop's device name and 6-digit code shown on the desktop HUD.
      </p>

      <div style="display: flex; flex-direction: column; gap: 4px;">
        <label style="font-size: 11px; color: var(--text-muted); font-weight: 600;">DEVICE NAME</label>
        <input type="text" id="deviceNameInput" class="input-field" value="${defaultDeviceName}" placeholder="e.g. Kshitij-Laptop" />
      </div>

      <div style="display: flex; flex-direction: column; gap: 4px;">
        <label style="font-size: 11px; color: var(--text-muted); font-weight: 600;">6-DIGIT PAIRING CODE</label>
        <input type="text" id="pairingInput" class="code-input" value="${defaultPairingCode}" maxlength="6" placeholder="482913" />
      </div>

      <button id="pairBtn" class="btn btn-primary">Connect →</button>
    </div>

    <!-- Main Controller Screen -->
    <div id="controlView" style="display: flex; flex-direction: column; gap: 16px;">
      <!-- Command Input -->
      <div class="glass-card">
        <label style="font-size: 11px; color: var(--text-muted); font-weight: 600; text-transform: uppercase;">Remote Command</label>
        <div style="display: flex; gap: 8px; margin-top: 8px;">
          <input type="text" id="cmdInput" placeholder="Command your PC from phone..." style="flex: 1; padding: 12px 14px; background: rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; color: #fff; font-size: 14px; outline: none;" />
          <button id="sendBtn" class="btn btn-primary" style="padding: 10px 16px;">Send</button>
        </div>

        <div style="display: flex; flex-direction: column; gap: 6px; margin-top: 12px;">
          <span style="font-size: 11px; color: var(--text-muted); font-weight: 600;">DEMO SHORTCUTS:</span>
          <div class="chip" onclick="setCmd('Upload today\\'s report to Drive and send me the link')">
            📤 <strong>Drive Upload:</strong> Upload today's report to Drive and send me the link
          </div>
          <div class="chip" onclick="setCmd('Hey Vanessa, investigate why the checkout service is failing. Check the recent code changes, logs, previous incidents and runbook. Prepare a fix, run the tests, and explain what you found. Don\\'t deploy anything.')">
            🔍 <strong>Incident v0.2:</strong> Investigate checkout failure (3 concurrent workers)
          </div>
          <div class="chip" onclick="setCmd('Hey Vanessa, my Wi-Fi isn’t working—restart the adapter.')">
            📶 <strong>Wi-Fi Control:</strong> Restart Wi-Fi adapter
          </div>
        </div>
      </div>

      <!-- Pending Approval Card (shows when risky command triggers confirmation) -->
      <div id="approvalCard" class="glass-card" style="display: none; border-color: var(--amber); background: rgba(245, 158, 11, 0.08);">
        <div style="display: flex; align-items: center; gap: 8px; color: var(--amber); font-weight: 700; font-size: 14px;">
          <span>⚠️ Confirmation Required</span>
        </div>
        <p id="approvalText" style="font-size: 13px; color: #fff; margin: 8px 0 12px 0; line-height: 1.4;">
          Vanessa wants to upload 'Project_Vanessa_Report.pdf' to Google Drive and create a shareable link.
        </p>
        <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 12px;">
          Folder: <strong>Documents/VanessaDemo</strong> • Risk: <strong>External share</strong>
        </div>
        <div style="display: flex; gap: 8px;">
          <button id="denyBtn" class="btn btn-deny">Deny</button>
          <button id="approveBtn" class="btn btn-approve">Approve Once</button>
        </div>
      </div>

      <!-- Task Status & Execution Timeline -->
      <div class="glass-card">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
          <span style="font-size: 12px; color: var(--text-muted); font-weight: 600; text-transform: uppercase;">Task Execution</span>
          <span id="planStatus" style="font-size: 11px; color: var(--cyan);">Ready</span>
        </div>

        <div id="spokenResponse" style="font-size: 13px; color: #fff; line-height: 1.4; padding: 10px; background: rgba(0,0,0,0.3); border-radius: 8px; margin-bottom: 10px;">
          "Ready for command from phone."
        </div>

        <div id="timelineContainer" style="display: flex; flex-direction: column; gap: 8px;"></div>

        <!-- Result / Share Link Card -->
        <div id="resultCard" style="display: none;">
          <div style="font-size: 12px; color: var(--green); font-weight: 600; margin-top: 10px;">
            🎉 Result Ready:
          </div>
          <div class="result-link">
            <span id="linkUrl" style="font-size: 12px; color: var(--cyan);"></span>
            <button onclick="copyLink()" style="background: var(--cyan); border: none; color: #000; padding: 4px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; cursor: pointer; margin-left: 8px;">COPY</button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script>
    let token = localStorage.getItem("vanessa_phone_token") || "vtok_active_session";
    let pendingTaskId = null;

    function setCmd(text) {
      document.getElementById("cmdInput").value = text;
      sendCommand();
    }

    async function sendCommand() {
      const input = document.getElementById("cmdInput");
      const cmd = input.value.trim();
      if (!cmd) return;

      document.getElementById("planStatus").innerText = "Executing...";
      document.getElementById("spokenResponse").innerText = "Executing on laptop orchestrator...";
      document.getElementById("resultCard").style.display = "none";
      document.getElementById("approvalCard").style.display = "none";

      try {
        const res = await fetch("/api/remote/command", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command: cmd, token })
        });
        const data = await res.json();

        if (data.status === "awaiting_approval") {
          document.getElementById("planStatus").innerText = "Awaiting Approval";
          document.getElementById("spokenResponse").innerText = data.spokenSummary;
          if (data.pendingTasks && data.pendingTasks.length > 0) {
            pendingTaskId = data.pendingTasks[0].id;
            document.getElementById("approvalText").innerText =
              "Vanessa wants to execute: " + data.pendingTasks[0].action + " on resource: " + (data.pendingTasks[0].params?.file || "system");
            document.getElementById("approvalCard").style.display = "block";
          }
        } else {
          document.getElementById("planStatus").innerText = "Completed";
          document.getElementById("spokenResponse").innerText = data.spokenSummary || "Task completed.";
          renderTasks(data.plan?.tasks || []);

          // Check if drive shareLink exists
          const driveTask = data.plan?.tasks?.find(t => t.action === "drive.upload");
          if (driveTask && driveTask.result?.shareLink) {
            document.getElementById("linkUrl").innerText = driveTask.result.shareLink;
            document.getElementById("resultCard").style.display = "block";
          }
        }
      } catch (err) {
        document.getElementById("planStatus").innerText = "Error";
        document.getElementById("spokenResponse").innerText = "Error: " + err.message;
      }
    }

    function renderTasks(tasks) {
      const container = document.getElementById("timelineContainer");
      container.innerHTML = "";
      tasks.forEach(t => {
        const item = document.createElement("div");
        item.className = "timeline-item";
        const isSuccess = t.status === "success";
        item.innerHTML = \`
          <div class="timeline-dot" style="background: \${isSuccess ? 'var(--green)' : 'var(--cyan)'}"></div>
          <div>
            <div style="font-weight: 600; color: #fff;">\${t.action}</div>
            <div style="font-size: 11px; color: var(--text-muted);">Status: \${t.status}</div>
          </div>
        \`;
        container.appendChild(item);
      });
    }

    document.getElementById("sendBtn").onclick = sendCommand;
    document.getElementById("cmdInput").onkeydown = (e) => {
      if (e.key === "Enter") sendCommand();
    };

    document.getElementById("approveBtn").onclick = async () => {
      if (!pendingTaskId) return;
      document.getElementById("approvalCard").style.display = "none";
      document.getElementById("spokenResponse").innerText = "Authorizing action on laptop...";
      try {
        const res = await fetch("/api/remote/approve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ taskId: pendingTaskId, token })
        });
        const data = await res.json();
        document.getElementById("spokenResponse").innerText = "Task approved and executed successfully.";
        document.getElementById("planStatus").innerText = "Success";
        if (data.task?.result?.shareLink) {
          document.getElementById("linkUrl").innerText = data.task.result.shareLink;
          document.getElementById("resultCard").style.display = "block";
        }
      } catch (err) {
        alert("Failed to approve: " + err.message);
      }
    };

    document.getElementById("denyBtn").onclick = async () => {
      document.getElementById("approvalCard").style.display = "none";
      document.getElementById("spokenResponse").innerText = "Action denied by user.";
      document.getElementById("planStatus").innerText = "Declined";
    };

    function copyLink() {
      const link = document.getElementById("linkUrl").innerText;
      navigator.clipboard.writeText(link);
      alert("Link copied to clipboard!");
    }
  </script>
  <!-- Deployed Fish Audio Voice Agent Widget -->
  <fish-agent agent-id="ade8c48b4ac94324b91e46230cf338c4"></fish-agent>
  <script src="https://unpkg.com/@fishaudio/agent-widget-embed" async type="text/javascript"></script>
</body>
</html>`;
}
