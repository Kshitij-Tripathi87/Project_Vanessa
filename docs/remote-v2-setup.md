# Vanessa remote v2 setup (Windows + Android)

This configures a private phone-to-PC connection. The orchestrator WebSocket listener remains on PC loopback (\`127.0.0.1:4321\`); Tailscale Serve provides the HTTPS/WSS endpoint inside the tailnet. Do not expose port 4321 with router port forwarding, a wildcard bind, a public reverse proxy, or Tailscale Funnel.

## Prerequisites

- Vanessa desktop is installed on the Windows PC.
- Tailscale is installed, signed in, connected, and MagicDNS is enabled for the tailnet.
- The Android device is signed in to the same tailnet.
- HTTPS certificates are enabled in the tailnet.
- Tailnet ACL/grants allow the phone to reach the PC's Tailscale Serve HTTPS port.

Tailscale Serve is tailnet-only; Funnel is the separate feature that exposes a service to the public internet. See the [Tailscale Serve reference](https://tailscale.com/docs/reference/tailscale-cli/serve) and [Serve feature guide](https://tailscale.com/docs/features/tailscale-serve).

## Configure

Open PowerShell under the Windows user account that runs Vanessa:

\`\`\`powershell
cd <Project_Vanessa checkout>
.\\scripts\\setup-vanessa-tailscale.ps1
\`\`\`

The first invocation is a preview. Review the displayed DNS endpoint and then apply:

\`\`\`powershell
.\\scripts\\setup-vanessa-tailscale.ps1 -Apply
\`\`\`

The script configures Tailscale Serve to proxy HTTPS port 8443 to \`http://127.0.0.1:4321\`, then writes these settings to the per-user Vanessa \`.env\`:

\`\`\`dotenv
VANESSA_REMOTE_V2_ENABLED=true
VANESSA_REMOTE_V2_BIND_HOST=127.0.0.1
VANESSA_REMOTE_V2_PORT=4321
VANESSA_REMOTE_V2_PUBLIC_ENDPOINT=wss://<pc-magicdns-name>:8443/remote/v2
VANESSA_MOBILE_GATEWAY_ENABLED=false
\`\`\`

The script does not reset existing Serve configuration. If the chosen HTTPS port conflicts with an existing route, inspect \`tailscale serve status\`, choose another \`-HttpsPort\`, or reconcile the existing Serve routes manually.

Restart Vanessa after applying the configuration. The desktop starts the authenticated v2 listener only when \`VANESSA_REMOTE_V2_ENABLED=true\` and the OS-backed PC identity signing broker is available. Pairing QR creation is intentionally refused when a WSS public endpoint is not configured.

## Pair the Android app

1. On the PC, open Vanessa's expanded HUD, choose **More → Manage paired devices**, then **Generate QR**.
2. On Android, open the Vanessa QR scanner and scan the displayed code.
3. The app verifies the PC public-key pin from the QR, signs a pairing claim with its Android Keystore identity, and answers the PC's nonce challenge.
4. The PC shows the phone under **Waiting for PC approval**. Review the requested device and choose its capability scopes. The default set is read/search/open; destructive and system-changing scopes are not selected.
5. Approve the phone from the PC UI. The Android client then authenticates a session and retrieves the PC's capability manifest.

The long-lived phone identity private key remains in Android Keystore. The PC private signing key remains in Electron main and is protected by Electron \`safeStorage\`. The orchestrator receives only a short-lived loopback signing capability, not the private key.

## Destructive approvals

When the phone app presents a destructive-action approval, the user-visible approval is bound to the task ID, capability, arguments-derived action hash, and expiry. The Android approval key is a second P-256 Keystore key that requires strong biometric authentication for each signature. The PC verifies the detached signature against the approval public key registered during pairing. A normal session signature is not considered biometric approval. If the proof is missing, expired, invalid, or the key is unavailable, the PC rejects approval.

## Revoke access

In **Manage paired devices**, use **Revoke** beside a trusted phone. The PC persists the revocation and closes its active WebSocket sessions immediately. The phone must be paired again to regain access.

## Diagnostics

\`\`\`powershell
tailscale status
tailscale serve status
\`\`\`

Confirm the backend is reachable locally before testing the phone:

\`\`\`powershell
Test-NetConnection 127.0.0.1 -Port 4321
\`\`\`

The pairing QR uses \`wss://.../remote/v2\`; it is not the old v1 six-digit/HMAC pairing flow. The legacy v1 mobile gateway stays disabled and loopback-only.

## Release validation boundary

Repository tests and CI can validate protocol parsing, signatures, pairing lifecycle, scoped authorization, task dispatch, result framing, and fail-closed approval. They cannot validate a real tailnet ACL, Android Keystore biometric hardware, Windows desktop state, mobile-data network switching, or the packaged installer on a physical PC/phone. Those remain explicit release gates; do not mark the product production-ready until the real-device acceptance suite passes.
