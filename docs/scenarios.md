# Vanessa Locked Demo Scenarios & Test Guide

Below are the 4 locked demo scenarios specified for the 10-day sprint and buildathon demonstration:

---

### Scenario 1: Wi-Fi Adapter Restart
- **Spoken Command**: `"Hey Vanessa, my Wi-Fi isn’t working—restart the adapter."`
- **Agents Involved**: `SystemAgent`
- **Actions**: `wifi.restart_adapter`
- **Safety Gate**: **Confirm (Ask First)**. Dropping network connectivity requires user confirmation.
- **Expected Outcome**:
  1. Vanessa flags task as `awaiting_approval`.
  2. Spoken response: *"This action requires confirmation: wifi restart adapter. Do you want me to proceed?"*
  3. When approved via voice ("Yes") or button, PowerShell command executes:
     `Restart-NetAdapter -Name "Wi-Fi" -Confirm:$false`
  4. Vanessa verifies connectivity and speaks: *"Wi-Fi adapter has been restarted and connectivity is verified."*

---

### Scenario 2: Parallel System & Browser Automation
- **Spoken Command**: `"Turn on Bluetooth, open Chrome, and create a Buildathon Demo folder."`
- **Agents Involved**: `SystemAgent`, `BrowserAgent`, `FileAgent`
- **Actions**:
  - `bluetooth.enable` (System)
  - `browser.open_url` (Browser)
  - `folder.create` (Files)
- **Safety Gate**: **Allowed**.
- **Expected Outcome**:
  1. All 3 tasks have empty `dependsOn: []`.
  2. The Task Runner fires them in parallel via `Promise.all`.
  3. HUD displays 3 concurrent active task cards.
  4. Spoken response: *"Done. Successfully completed enable, open url, and create."*

---

### Scenario 3: Autonomous Developer Assistant
- **Spoken Command**: `"Open Claude Code and ask it to build a landing page."`
- **Agents Involved**: `DeveloperAgent`
- **Actions**: `claude_code.open` (params: `{ prompt: "build a landing page" }`)
- **Safety Gate**: **Allowed / Launch-Only**.
- **Expected Outcome**:
  1. Spawns Claude Code CLI in an elevated or dedicated terminal with prompt as launch argument (`claude "build a landing page"`).
  2. Vanessa reports: *"Claude Code has been started in your terminal."*

---

### Scenario 4: Secure Cloud Storage & Link Generation
- **Spoken Command**: `"Upload the report to Drive and send me the link."`
- **Agents Involved**: `FileAgent`
- **Actions**: `drive.upload` (params: `{ file: "report.pdf" }`)
- **Safety Gate**: **Confirm (Ask First)**. Cloud uploads are verified by safety policy.
- **Expected Outcome**:
  1. Vanessa pauses for confirmation.
  2. Once approved, file is uploaded to Google Drive.
  3. Shareable link is generated (`https://drive.google.com/file/d/...`).
  4. Vanessa reports link and spoken summary.
