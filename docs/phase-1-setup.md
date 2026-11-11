# Phase 1.1: PC Baseline Setup Guide

## Prerequisites

1. **Ollama Installation**
   ```bash
   # Download from https://ollama.ai/download
   # Or use package manager:
   # Windows: winget install Ollama.Ollama
   # macOS: brew install ollama
   # Linux: curl -fsSL https://ollama.ai/install.sh | sh
   ```

2. **Pull LFM3 Model**
   ```bash
   ollama pull lfm3:latest
   ```

   Note: As of Nov 2024, LFM3 may not be officially available in Ollama yet. 
   Alternatives for testing:
   - Use `llama3.2:1b` or `llama3.2:3b` as a proxy
   - Wait for official LFM3 release
   - Use OpenAI backend for validation

3. **Verify Installation**
   ```bash
   ollama list
   ollama run lfm3:latest "Hello"
   ```

## Running the Evaluation

### Option 1: Ollama (Local)
```bash
cd /path/to/Project_Vanessa

# Test on English cases only (40 cases)
python3 eval/evaluate_router.py --backend ollama --input eval/router-v1.jsonl --output eval/results-en.json

# Test on Hinglish cases (30 cases)
python3 eval/evaluate_router.py --backend ollama --input eval/router-v1-hinglish.jsonl --output eval/results-hinglish.json

# Test on Hindi cases (30 cases)
python3 eval/evaluate_router.py --backend ollama --input eval/router-v1-hindi.jsonl --output eval/results-hindi.json
```

### Option 2: OpenAI (if Ollama unavailable)
```bash
export OPENAI_API_KEY=your_key_here

python3 eval/evaluate_router.py --backend openai --input eval/router-v1.jsonl --output eval/results-openai.json
```

### Option 3: Mock (for testing harness)
```bash
python3 eval/evaluate_router.py --backend mock --limit 10
```

## Expected Results (PC Baseline)

Based on the implementation plan targets:

**Accuracy**:
- English: ≥90% (36/40 cases)
- Hinglish: ≥80% (24/30 cases)
- Hindi: ≥80% (24/30 cases)

**Performance**:
- p50 latency: <500ms (local Ollama)
- p95 latency: <1000ms
- Invalid JSON rate: <5%

**Critical Failures**:
- T2 confirmation cases: 0 failures (must correctly route delete_file)
- UNSAFE cases: 0 failures (must correctly escalate unsafe requests)

## What Success Looks Like

```
============================================================
EVALUATION SUMMARY
============================================================
Overall Accuracy: 86/100 (86.0%)

By Language:
  en        :  37/ 40 ( 92.5%)
  hi        :  24/ 30 ( 80.0%)
  hinglish  :  25/ 30 ( 83.3%)

Latency:
  p50: 342ms
  p95: 678ms

Critical Failures (T2/UNSAFE): 0
============================================================
```

## Troubleshooting

**Ollama not responding**:
```bash
# Check if Ollama service is running
ollama serve

# In another terminal:
curl http://localhost:11434/api/tags
```

**Model too slow**:
- Check GPU availability: `nvidia-smi` (NVIDIA) or `rocm-smi` (AMD)
- Try smaller quantization: `ollama pull lfm3:1.7b-q4_0`

**High error rate**:
- Check tool schemas are loaded correctly
- Verify system prompt in `evaluate_router.py`
- Test with a few cases manually: `ollama run lfm3 "Open Chrome"`

## Current Status

- [x] Evaluation harness implemented
- [x] Tool schemas defined (10 tools)
- [x] Test cases ready (100 cases)
- [ ] Ollama installed with LFM3
- [ ] Baseline evaluation run
- [ ] Results documented
