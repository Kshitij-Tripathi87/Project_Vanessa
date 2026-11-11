# Vanessa Mobile + PC: Rapid Implementation Roadmap

**Date**: 2026-11-04  
**Status**: Phase 0-2 Complete, Phase 3-10 Planning

---

## ✅ Completed Phases (Weeks 0-1)

### Phase 0: Foundations ✅
- Protocol package with 11 message types
- 100-case eval test set (EN/HI/Hinglish)
- Documentation and tracking

### Phase 1: Model Validation ✅ (Infrastructure)
- Tool schemas (11 tools)
- Evaluation harness (multi-backend)
- Router decision: **PC-based router**

### Phase 2: PC Agent Core ✅
- Gateway server (WebSocket)
- Tool registry + manifest
- Execution control state machine
- 11 tools implemented (T0/T1/T2)
- SQLite audit log

**Total Code**: ~3,500 lines (TypeScript/Python)

---

## 🚀 Remaining Implementation (Weeks 2-10)

### Phase 3: Connectivity and Security (Week 2)

#### Step 3.1: Tailscale Setup
**Priority**: HIGH - Required for secure device-to-device communication

**Implementation**:
```typescript
// apps/desktop/src/main/tailscale.ts
- Check if Tailscale installed
- Get Tailscale IP
- Configure gateway to listen on Tailscale interface only
- Verify mesh connectivity
```

**Commands**:
```bash
tailscale status
tailscale ip
```

#### Step 3.2: Pairing (QR Code)
**Priority**: HIGH - First-time setup

**Implementation**:
```typescript
// apps/desktop/src/main/pairing.ts
- Generate shared secret (32 bytes)
- Create pairing payload: { pcIP, port, secret }
- Generate QR code
- Display in Electron window
- Phone scans -> establishes connection
```

#### Step 3.3: Message Signing, Tiers, Confirmations
**Priority**: HIGH - Security critical

**Implementation**:
```typescript
// apps/desktop/src/main/security.ts
- HMAC-SHA256 signing with shared secret
- Verify signature on every message
- Replay attack prevention (timestamp + nonce)
- Device revocation support
```

**Protocol Update**:
- All messages include `signature` field
- PC verifies before processing
- Invalid signature -> disconnect

#### Step 3.4: Automated Security Suite
**Priority**: MEDIUM - Testing

**Implementation**:
```typescript
// eval/security_tests.py
- Test invalid signatures (must reject)
- Test replayed messages (must reject)
- Test unauthorized tools (must reject T2 without confirm)
- Test permission escalation (must fail)
- Test payload size limits
- Test rate limiting
```

**Acceptance**: A7 - 100% attacks fail safely

---

### Phase 4: Android Skeleton (Weeks 2-3)

#### Step 4.1: Project and Bridge Client
**Tech Stack**: Kotlin + Jetpack Compose + Ktor WebSocket

```kotlin
// apps/android/core/bridge/
- WebSocket client to PC gateway
- Message serialization (from protocol JSON Schema)
- Connection lifecycle (connect/disconnect/reconnect)
- Auto-reconnect with exponential backoff
```

#### Step 4.2: Manifest Sync and Debug Console
```kotlin
// apps/android/ui/
- Receive manifest.sync from PC
- Display available tools in debug UI
- Show connection status (PC online/offline)
- Manual tool trigger for testing
```

#### Step 4.3: Result Rendering
```kotlin
// apps/android/ui/components/
- Display task results as cards
- Show loading states during execution
- Error handling and retry
- Confirmation dialogs for T2 actions
```

---

### Phase 5: Voice Pipeline (Weeks 3-4)

#### Step 5.1: Push-to-Talk STT
**Options**: Sarvam AI (Hindi), OpenAI Whisper, or Google Speech

```kotlin
// apps/android/voice/
- Record audio on button press
- Send to STT API
- Return transcription text
- Handle errors (network, API)
```

#### Step 5.2: TTS and Barge-in
```kotlin
// apps/android/voice/
- Text-to-speech for results
- Interrupt speech on new input (barge-in)
- Queue management
```

#### Step 5.3: Provider Adapters, Sarvam, Credit Guard
```kotlin
// apps/android/voice/providers/
- SarvamSTT.kt (Hindi STT)
- WhisperSTT.kt (English STT)
- ElevenLabsTTS.kt or GoogleTTS.kt
- Credit tracking (warn at 80%, block at 100%)
```

#### Step 5.4: Latency Instrumentation
```kotlin
// apps/android/analytics/
- Track: button press -> STT -> router -> PC -> result -> TTS
- Log p50/p95 latencies
- Identify bottlenecks
```

**Target**: <2.5s end-to-end (A1 acceptance test)

---

### Phase 6: Router (Weeks 4-5)

**Decision from Phase 1**: Router on PC

#### Step 6.1: Fast Path (Regex Rules)
```typescript
// apps/desktop/src/main/router/fastPath.ts
- Regex patterns for common commands
- "open chrome" -> open_app(chrome)
- "lock" -> lock_pc()
- "battery" -> system_status(battery)
- Bypass LLM for 20% of requests
```

#### Step 6.2: Tool Retrieval (BM25)
```typescript
// apps/desktop/src/main/router/retrieval.ts
- BM25 scoring over tool descriptions
- Retrieve top 3 relevant tools
- Pass to LLM with focused context
- Reduces hallucination
```

#### Step 6.3: LFM3 Integration
```typescript
// apps/desktop/src/main/router/llm.ts
- Ollama client for LFM3
- Function calling with tool schemas
- Extract tool + arguments
- Fallback to escalate on parse error
```

#### Step 6.4: Validation, Escalation, Fallback
```typescript
// apps/desktop/src/main/router/validation.ts
- Validate LLM output against schema
- Escalate if: multi-step, chat, unsafe, unclear
- Fallback chain: LLM -> escalate -> error
```

**Target**: 90% EN, 80% HI/Hinglish accuracy (A6 acceptance test)

**Milestone M1** (Week 5): Talk to phone, PC acts! 🎉

---

### Phase 7: Brain and Memory (Weeks 5-7)

#### Step 7.1: Memory Store (SQLite)
```typescript
// apps/desktop/src/main/memory/
- Conversation history per device
- Entity extraction (files, apps, people)
- Context window (last N messages)
- Expiry (30 days)
```

#### Step 7.2: Brain Service (Tier 3)
```typescript
// apps/desktop/src/main/brain/
- Escalated tasks go to GPT-4 or Claude
- Multi-turn conversations
- File content analysis
- Complex reasoning
```

#### Step 7.3: Planner and Multi-step Execution
```typescript
// apps/desktop/src/main/planner/
- Break complex tasks into steps
- "Find PDF from yesterday and show page one"
  -> find_file(pdf, yesterday) -> open_file(result[0])
- Sequential execution with feedback
```

#### Step 7.4: Verification Loop
```typescript
// apps/desktop/src/main/brain/verifier.ts
- Check execution results
- Retry on failure (with different approach)
- Confirm with user if uncertain
```

---

### Phase 8: Product Polish (Weeks 7-8)

#### Step 8.1: Proactive Events
```kotlin
// PC sends event.push for:
- Battery low (<15%)
- File download complete
- Calendar reminders
- Build failures (if dev tools)
```

#### Step 8.2: File Transfer
```typescript
// Small files (<5MB) sent via WebSocket
// Large files via HTTP endpoint
// Preview images inline in results
```

#### Step 8.3: UX States and Errors
```kotlin
// Polished UI states:
- Loading: shimmer effects
- Success: checkmark + haptic
- Error: actionable messages ("PC offline - check Tailscale")
- Empty states
```

#### Step 8.4: Hindi and Hinglish
```kotlin
// Full Hindi UI strings
// Hinglish transcription handling
// Fallback to English if needed
```

---

### Phase 9: Always-on Mode (Weeks 8-9)

#### Step 9.1: Microphone Foreground Service
```kotlin
// Android foreground service
- Always listening (with permission)
- Persistent notification
- Low battery impact (<2%/hour)
```

#### Step 9.2: Wake Word (Porcupine)
```kotlin
// Picovoice Porcupine
- Custom wake word: "Hey Vanessa"
- On-device processing
- Trigger STT on detection
```

#### Step 9.3: Default Assistant (VoiceInteractionService)
```kotlin
// Register as voice assistant
- Override Google Assistant button
- Handle voice intents
- Fallback to Google for general queries
```

#### Step 9.4: PC Availability (Wake-on-LAN)
```typescript
// Phone checks PC status
// Send WOL magic packet if sleeping
// Wait for PC to wake (~5s)
// Then submit task
```

---

### Phase 10: Fine-tune and Release (Weeks 9-10)

#### Step 10.1: Fine-tune the Router
```python
# Fine-tune LFM3 on eval set + real usage data
# Target: 95% EN, 90% HI/Hinglish
# Package fine-tuned model with desktop app
```

#### Step 10.2: Soak and Chaos Tests
```python
# eval/chaos_tests.py
- Random disconnections
- Slow networks
- Malformed messages
- Concurrent tasks
- Memory leaks
- 24-hour soak test
```

#### Step 10.3: Release and Demo
```
- Package desktop app (Electron)
- APK for Android
- Demo video
- Documentation
- GitHub release
```

---

## Summary

| Phase | Weeks | Status | LOC | Priority |
|-------|-------|--------|-----|----------|
| 0: Foundations | 0 | ✅ | 500 | - |
| 1: Model Validation | 1 | ✅ | 600 | - |
| 2: PC Agent Core | 1-2 | ✅ | 1900 | - |
| 3: Security | 2 | 📋 Next | 400 | HIGH |
| 4: Android Skeleton | 2-3 | 📋 | 800 | HIGH |
| 5: Voice Pipeline | 3-4 | 📋 | 600 | MEDIUM |
| 6: Router | 4-5 | 📋 | 500 | HIGH |
| 7: Brain + Memory | 5-7 | 📋 | 800 | MEDIUM |
| 8: Polish | 7-8 | 📋 | 400 | LOW |
| 9: Always-on | 8-9 | 📋 | 600 | LOW |
| 10: Release | 9-10 | 📋 | 300 | - |
| **Total** | **10 weeks** | **30%** | **~7,400** | - |

---

## Critical Path (MVP)

**Must Have** (for M1 milestone):
1. ✅ Phase 0-2: PC Agent Core
2. 🔲 Phase 3: Security (Tailscale + signing)
3. 🔲 Phase 4: Android app (bridge + UI)
4. 🔲 Phase 5: Voice (STT + TTS)
5. 🔲 Phase 6: Router (LLM integration)

**Nice to Have** (post-M1):
- Phase 7: Brain (complex tasks)
- Phase 8: Polish
- Phase 9: Always-on mode
- Phase 10: Fine-tuning

---

## Next Session Plan

**Immediate**: Start Phase 3 (Connectivity and Security)
1. Tailscale integration
2. Pairing with QR code
3. Message signing
4. Security test suite

**Timeline**: Phase 3 = ~4 hours of work

Would you like me to continue implementing, or would you prefer to review what's been built so far?
