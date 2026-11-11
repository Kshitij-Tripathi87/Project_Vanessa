# ADR 001: Router Location Decision

**Status**: ✅ DECIDED  
**Date**: 2026-11-04  
**Deciders**: Engineering Team  
**Decision**: Router on PC  

## Context

Vanessa Mobile + PC Agent requires a router component that:
1. Receives voice transcription (text)
2. Selects the appropriate tool from 10+ available tools
3. Extracts structured arguments
4. Handles multilingual input (English, Hindi, Hinglish)

The router can run either on the **phone** or the **PC**. This decision significantly impacts:
- System latency (phone = lower, PC = higher due to network)
- Offline capability (phone = partial, PC = none)
- Development complexity (phone = higher)
- Reliability (phone = battery/thermal concerns)

## Decision

**DECIDED: Router on PC (Option B)**  
**Date**: 2026-11-04  
**Rationale**: Conservative choice to maintain development velocity

**Selected Option**: Option B - Router on PC

## Decision Criteria

### Option A: Router on Phone
**Requirements** (ALL must be met):
- ✅/❌ Time to first token < 1s
- ✅/❌ Full tool call generation < 1.5s (≈40 tokens @ 27 tok/s)
- ✅/❌ RAM usage < 500MB
- ✅/❌ Device temperature < 42°C under sustained load
- ✅/❌ Battery drain < 2% per 100 inferences
- ✅/❌ Accuracy ≥80% on all languages

### Option B: Router on PC
**Triggers** (ANY of):
- Phone inference too slow (>1.5s per call)
- RAM usage too high (>500MB)
- Thermal throttling issues
- Battery drain unacceptable
- Accuracy degradation on phone

## Test Results

### PC Baseline (Step 1.1)
**Status**: Infrastructure complete, model testing deferred  
**Date**: 2026-11-04

**Decision Made Without Full Testing** due to:
- LFM3 not yet available in Ollama
- Time constraints for implementation
- Evaluation harness verified working with mock backend

### Phone Feasibility (Step 1.2)
**Status**: Skipped for initial implementation  
**Rationale**: 
- Requires physical Android device and GGUF model
- Phone router is optimization, not MVP requirement
- Can be revisited after M1 milestone (Week 5)

## Why Router on PC?

**Primary Reasons**:
1. **Simpler Android App**: Phone only handles voice I/O and UI
2. **No Battery Concerns**: PC handles compute-intensive inference
3. **Easier Updates**: Model updates don't require app release
4. **Proven Architecture**: WebSocket bridge is well-understood
5. **Development Velocity**: Unblocks Phase 2 implementation

**Accepted Trade-offs**:
- Higher latency: +100-300ms for network round-trip (acceptable for voice)
- No offline mode: Requires PC connection (acceptable for MVP)
- Privacy: Text goes over Tailscale mesh (encrypted, acceptable)

**Revisit Criteria**:
- After M1 milestone when core functionality proven
- If user feedback indicates latency is problematic
- When LFM3 GGUF models become readily available
- If offline mode becomes critical requirement

## Consequences

### If Option A: Router on Phone

**Pros**:
- Lower latency (no network round-trip)
- Works partially offline (tool execution still needs PC)
- Better privacy (text never leaves device)
- Scales with phone hardware improvements

**Cons**:
- More complex Android app (model inference + UI)
- Battery and thermal management required
- Model updates require app updates
- Larger app download size

**Architecture**:
Phone: [Voice] -> [STT] -> [Router LFM3] -> [Bridge Client] -> PC

### If Option B: Router on PC

**Pros**:
- Simpler Android app (just voice I/O + UI)
- No phone battery/thermal concerns
- Easier model updates (PC-side only)
- Can use larger/better models on PC

**Cons**:
- Higher latency (+100-300ms network round-trip)
- Requires PC always available
- No offline capability at all
- Privacy: text goes over network

**Architecture**:
Phone: [Voice] -> [STT] -> [Bridge Client] -> PC: [Router] -> [Tools]

## Reversibility

**Medium**: Switching router location requires:
1. Refactor bridge protocol (text-only vs tool-call messages)
2. Move model inference code
3. Update Android app architecture
4. Retest entire flow

Estimated effort: 1-2 weeks

## References

- Implementation Plan: Section 6 (Phase 1: Model Validation)
- Protocol Package: packages/protocol/
- Tool Schemas: eval/tool_schemas.py
- Test Results: eval/results-*.json
