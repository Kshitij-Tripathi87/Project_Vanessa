# Phase 1: Model Validation

## Overview

Phase 1 validates whether LFM3-1.7B can serve as the router model and decides where it should run (PC vs. phone).

## Steps

### Step 1.1: PC Baseline ✅ IN PROGRESS
**Goal**: Establish baseline accuracy with LFM3 running on PC via Ollama

**Deliverables**:
- Ollama installation verification
- 10 tool schemas from Appendix A loaded
- Eval runner script that tests all 100 cases
- Results: accuracy per language, invalid JSON rate, latency (p50, p95)

**Acceptance Criteria**:
- English: ≥90% accuracy
- Hindi/Hinglish: ≥80% accuracy
- Invalid JSON rate: <5%
- P50 latency: <500ms (local inference)

### Step 1.2: Phone Feasibility ⏭️ PENDING
**Goal**: Determine if LFM3-1.7B can run acceptably on Android

**Deliverables**:
- Q4 GGUF build of LFM3-1.7B
- Android sample app with llama.cpp integration
- Performance measurements on target device

**Metrics to Measure**:
- Time to first token (target: <1s)
- Tokens per second (target: ~40 token tool call in <1.5s = 27 tok/s)
- RAM usage
- Device temperature
- Battery drain (% per 100 inferences)

### Step 1.3: Decision Gate ⏭️ PENDING
**Goal**: Document where router runs based on data

**Decision Criteria**:
```
IF phone meets ALL of:
  - TTFT < 1s
  - Full tool call < 1.5s
  - RAM < 500MB
  - Temperature acceptable (<42°C)
  - Battery drain reasonable (<2% per 100 calls)
THEN: Router on phone (preferred architecture)
ELSE: Router on PC, phone sends text only
```

**Deliverable**: `docs/decisions/001-router-location.md`

## Current Status

- [x] Phase 0 complete
- [ ] Ollama + LFM3 installed
- [ ] Tool schemas defined
- [ ] Eval harness implemented
- [ ] PC baseline results collected
- [ ] Android feasibility tested
- [ ] Decision documented

## Notes

**Why This Matters**: The router location decision affects the entire architecture:
- Phone router = lower latency, works partially offline, more complex Android app
- PC router = simpler phone app, requires always-on PC connection

**Model Choice**: LFM3-1.7B is specifically designed for function calling and multilingual support (Hindi + English), making it ideal for this use case.
