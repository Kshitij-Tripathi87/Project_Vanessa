# Vanessa remote v2 setup (Windows + Android)

This guide describes the current authenticated protocol-v2 connection. The PC listener binds to the PC's **verified Tailscale IPv4 address** on TCP port **4321** by default. It does not use a public listener, router port forwarding, Tailscale Funnel, or the legacy v1/HMAC gateway.

## Prerequisites

- Vanessa desktop is running on the Windows PC.
- Tailscale is installed, signed in, and connected on both the Windows PC and Android phone.
- Both devices belong to the same tailnet and tailnet ACL/grants permit the phone to reach the PC on TCP port 4321.
- The Tailscale CLI is available to the Vanessa desktop process. On Windows the app checks `tailscale.exe` and the standard Program Files path.

The PC backend runs `tailscale ip -4` and verifies that the returned address is assigned to a non-loopback network interface and is in the Tailscale CGNAT range (100.64.0.0/10). If it cannot verify the address, the remote listener stays offline.

## Windows Firewall

The app binds only to the verified Tailscale IPv4 address on TCP port 4321. Windows Defender Firewall must also allow inbound traffic on that exact local address. From an elevated PowerShell session, run:

```powershell
.\scripts\setup-vanessa-tailscale.ps1
```

The script reads the address from `tailscale ip -4`, verifies it is in `100.64.0.0/10` and assigned locally, then creates one inbound TCP rule scoped to that local address and the Tailscale peer range. Tailnet ACLs/grants must still limit which devices may connect. No LAN/wildcard rule, port forwarding, Tailscale Serve, or Funnel configuration is created.

To remove the rule:

```powershell
.\scripts\setup-vanessa-tailscale.ps1 -Remove
```

## Start the remote listener

1. Start Tailscale on both devices and confirm they show as connected in the same tailnet.
2. Start or restart Vanessa desktop.
3. Confirm the Windows PC has a Tailscale IPv4 address:

   ```powershell
   tailscale status
   tailscale ip -4
   ```

4. The desktop application initializes its OS-backed PC identity signer and starts the v2 listener on the verified Tailscale interface, port 4321 by default. The packaged application hard-disables the legacy v1/HMAC gateway.

Do not expose port 4321 through router port forwarding, a public reverse proxy, or Tailscale Funnel. Do not bind the listener to `0.0.0.0`, a LAN address, or a guessed 100.64/10 address.

If the listener is offline, inspect the Vanessa desktop/orchestrator logs for the remote-v2 startup reason. The app fails closed if the Tailscale address or OS-backed signing service cannot be verified.

## Pair the Android app

1. On Windows, press **Ctrl+Shift+P** to open Vanessa's PC pairing window.
2. Choose **Generate QR**. The QR contains a one-time pairing payload, the PC endpoint, the PC public-key identity and fingerprint, and the short-lived pairing code.
3. On Android, open **My PC → Pair with Windows → Scan PC pairing code** and scan that QR.
4. Android validates the endpoint is a WebSocket URL on a Tailscale IPv4 address, verifies the PC key ID/fingerprint match, then pins that PC identity.
5. Android proves possession of its own Keystore identity by signing the pairing claim and responding to the PC's signed challenge.
6. The Windows PC displays the pending phone. Review its identity and requested scopes, then approve it locally on the PC.
7. Android authenticates the session and retrieves the PC capability manifest. A paired device and a currently connected session are different states.

The Android identity private key remains in Android Keystore. The PC identity private key remains behind the Electron-main OS-backed identity store. The orchestrator requests typed signatures through a token-protected loopback signer bridge; it does not receive the PC private key.

## Scope and biometric boundary

Grant only the capabilities the phone needs. The app and server validate scopes on every request.

The Android app uses a separate per-use biometric Keystore key for protected-action approval. **PC-side Android hardware-key attestation verification is not implemented yet.** A public key supplied during pairing is self-asserted and does not prove hardware backing or biometric policy. The PC therefore denies the `files.delete` scope until attestation verification is implemented and tested. Do not manually add this scope to the trusted-device store.

## Revoke a phone

Press **Ctrl+Shift+R** on the Windows PC to open trusted-device management. Revoke the selected device. Revocation is persisted by the PC and active sessions for that device are closed.

## Diagnostics

On Windows:

```powershell
tailscale status
tailscale ip -4
Test-NetConnection <PC-Tailscale-IPv4> -Port 4321
```

Check that the endpoint in the QR uses `ws://<PC-Tailscale-IPv4>:4321`. The Android parser rejects public hostnames, non-Tailscale addresses, URLs with user information/query/fragment, and endpoints with an unexpected path. Tailscale supplies the private network transport; the v2 application protocol independently authenticates and signs every envelope.

## Release validation boundary

Automated tests cover signed pairing, session replay protection, task authorization, task delivery/recovery, result verification, and fail-closed destructive scopes. These tests do not prove physical Android/Windows pairing, actual tailnet ACL configuration, mobile-data/Wi-Fi handoff, biometric hardware behavior, release signing, or real-device soak. Those remain release gates.
