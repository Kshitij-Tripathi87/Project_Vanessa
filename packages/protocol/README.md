# Vanessa Protocol Package

Contract-first message schemas for Vanessa Mobile + PC communication.

## Architecture

- **Phone (Kotlin)**: Voice front-end, LFM3 router, bridge client
- **PC (Electron + Node)**: Gateway, execution control, tools, brain
- **Link**: Tailscale mesh, WebSocket, JSON messages, signed per message

## Message Types

### Task Lifecycle
- `task.submit` - Phone initiates a task
- `task.accepted` - PC accepted the task
- `task.progress` - Streaming state updates
- `task.confirm_required` - Tier 2 requires biometric confirmation
- `task.confirm` - Phone sends signed confirmation
- `task.result` - Task completed successfully
- `task.error` - Task failed
- `task.cancel` - Phone cancels a running task

### System
- `manifest.sync` - PC sends tool manifest to phone
- `event.push` - PC sends proactive events
- `ping` / `pong` - Keepalive

## Permission Tiers

- **T0**: Auto - read-only, no side effects (e.g., system_status, find_file)
- **T1**: Auto, logged - system changes (e.g., open_app, set_volume)
- **T2**: Confirm - destructive, requires biometric (e.g., delete_file)

## Build

```bash
pnpm build
```

Generates:
1. TypeScript declarations in `dist/`
2. JSON Schema in `schema/protocol-v1.schema.json`
3. Kotlin data classes in `../../apps/android/core/protocol/src/main/kotlin/`

## Contract-First Rule

> Change the protocol package before either side.

Any protocol change must:
1. Update zod schemas in `src/protocol.ts`
2. Run `pnpm build` to regenerate artifacts
3. Update both PC and Android code to match
4. Add test cases for the new message type
