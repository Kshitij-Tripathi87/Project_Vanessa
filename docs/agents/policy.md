# Policy and Permission Service

**ID:** policy / permissionGuard. Deterministic service, not an LLM agent.

## Responsibility
Allow, confirm or block based on user/device identity, action, parameters, workspace, risk, data sensitivity and configured policy.

## Requirements
- Approval derives server-side; client flags saying approval is unnecessary are ignored.
- Tools are registered and parameters validated.
- Block dangerous shell execution, path traversal, secret exfiltration and disallowed privilege escalation.
- Require confirmation for destructive edits, sensitive external side effects, credential use and data uploads as policy dictates.
- Bind approval to exact action/parameter digest, user, target device and expiry.
- Recheck authorization when executing.
- Audit approvals and denials without recording secrets.
- Revocation and policy updates affect subsequent calls.

## Browser safety
Permit safe HTTP/HTTPS. Reject JavaScript URLs, dangerous data URLs and unexpected schemes. File URLs require explicit scoped policy. Downloads, purchases, credential entry and external forms are separate risk-bearing actions.

## Tests
Forged approval flag, changed parameters after approval, expired approval, wrong device, denied tool, path traversal, unsafe URL and secret-safe audit log.