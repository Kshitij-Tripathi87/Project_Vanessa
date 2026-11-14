# Vanessa remote v2: Windows and Android over Tailscale

## Scope and security boundary

The Windows orchestrator listens on 127.0.0.1:4321 only. Tailscale Serve is the only supported remote ingress: it terminates HTTPS and forwards traffic to that loopback listener inside the private tailnet. The app does not bind the orchestrator to a LAN or public interface.

Do not use Tailscale Funnel, router port forwarding, public reverse proxies, or a publicly reachable WebSocket endpoint for Vanessa remote control.

Both Windows and Android devices must be signed in to the same Tailscale tailnet. The tailnet must have HTTPS certificates enabled and its ACL/grants must permit the phone to access the Windows node's HTTPS Serve endpoint. Tailscale can route directly or relay encrypted traffic when a direct peer path is unavailable; this is transport, not application authorization.

## Windows setup

1. Install and sign in to Tailscale on the Windows PC.
2. Enable HTTPS certificates in the tailnet administration settings.
3. Open the Vanessa user-data .env file. Set:

       VANESSA_REMOTE_V2_ENABLED=true

   The Windows launcher provisions the PC identity using Electron's OS-backed encryption. Do not copy the identity file or private key to another device.
4. Restart Vanessa Desktop. When the local orchestrator starts, the runtime attempts to configure Tailscale Serve for http://127.0.0.1:4321 at /remote-v2. The desktop pairing panel reports whether v2 is enabled and the WSS URL is configured.

If the Tailscale CLI is not on PATH or automatic setup fails, run:

       tailscale status --json
       tailscale serve --bg --set-path=/remote-v2 http://127.0.0.1:4321
       tailscale serve status

Find the Windows node's MagicDNS FQDN from tailscale status --json, then set the corresponding URL in Vanessa's .env file:

       VANESSA_REMOTE_V2_PUBLIC_URL=wss://<windows-node>.<tailnet>.ts.net/remote-v2

Restart Vanessa Desktop after changing .env. The URL must use wss:// and path /remote-v2.

To remove the Serve route, run:

       tailscale serve off

## Android pairing

1. Install and sign in to Tailscale on the Android phone using the same tailnet.
2. Keep Tailscale connected. The phone can use Wi-Fi or mobile data; both routes still go through the tailnet.
3. Open Vanessa Desktop and choose Pair Android over Tailscale from its menu.
4. Generate a one-time pairing QR. It expires; generate another if the code expires.
5. On Android, select Scan QR and scan the desktop QR image. Paste the copied payload into the text field as a fallback, then select Pair / connect to PC.
6. Confirm that the phone appears in the Windows panel and approve only the scopes needed. The approval decision must happen on the Windows PC.
7. Confirm the Android app shows Paired and connected. It stores only the PC public identity and session metadata; private signing keys remain in Android Keystore.

## First smoke test

With both devices online on the same tailnet and Wi-Fi turned off on the phone (mobile data on):

1. Submit a harmless URL through Open URL on Windows PC.
2. Confirm the request is accepted on Android and that the task progress/result appears.
3. Confirm the browser actually opens on Windows. A received WebSocket result alone is not proof that the desktop UI action occurred; the PC-side verifier and the visible application state must agree.
4. Reconnect after briefly disconnecting the phone from Tailscale and confirm the paired identity resumes without a new pairing code.
5. Revoke the phone from the Windows trusted-device management surface before treating a shared or lost phone as safe.

The app's CI build is not a substitute for this real cross-network test. Record device model, Android version, Windows build, Tailscale version, network path (direct or relayed), timestamps, task IDs, and the outcome for each test.

## Known limits in this implementation slice

- Android QR scanning uses Google Play services Code Scanner. Devices without a compatible scanner can paste the copied JSON payload as a fallback.
- Task progress/result is delivered over the active session. Durable event replay after a long offline window still needs implementation.
- Automatic Tailscale Serve setup depends on the Windows CLI and a signed-in tailnet. If it is unavailable, configure it manually as described above.
- Physical phone, Windows app, and mobile-data acceptance tests remain a release gate.
