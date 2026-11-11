# Router evaluation v1

`router-v1.jsonl` is a fixed 100-case regression set from Appendix B of the Vanessa implementation plan: 40 English, 30 Hindi, and 30 Hinglish cases. Expectations must be changed only to correct an identified ambiguity; record a replacement case and rationale in version control.

Validate data coverage with:

```sh
pnpm --filter @vanessa/orchestrator exec tsx ../../eval/router-eval.ts ../../eval/router-v1.jsonl
```

Run the repeatable local Ollama PC baseline with:

```sh
node eval/run-ollama-router.mjs
```

The baseline calls Ollama's `/api/chat` with the 10 Appendix A tools plus `escalate`, temperature `0.1`, and `think: false` for compact command routing. It performs one warm-up call, evaluates each fixed utterance once, and saves per-case predictions, Ollama timing counters, and scorer output under `eval/results/`. `think: false` is deliberate: Ollama reports LFM3's default thinking mode as enabled, which exhausted the short-output budget on many simple routing prompts. Set `VANESSA_ROUTER_MODEL`, `VANESSA_ROUTER_NUM_PREDICT`, or `OLLAMA_HOST` for a comparison run.

Model runners write one prediction per line to a separate file:

```json
{"id":"E10","raw":"{\"t\":\"open_app\",\"a\":{\"app\":\"chrome\"}}","latencyMs":212,"confirmationRequired":false}
```

Score it with:

```sh
pnpm --filter @vanessa/orchestrator exec tsx ../../eval/router-eval.ts ../../eval/router-v1.jsonl predictions.jsonl
```

The scorer checks JSON shape, tool, required arguments, extra arguments, string matching, aliases and defaults. It reports accuracy by language and tool, escalation precision and recall, invalid-output rate, critical failures, and p50/p95 latency. Every emitted deletion is critical unless it matches the expected target and reaches the confirmation path; a non-escalation tool on an `UNSAFE` case is critical.

## Language and ambiguity review

The 20-case review sample from the source plan was checked for one clear action and arguments: E05, E17, E32, E36, E38; H04, H12, H23, H27, H29; X04, X12, X24, X28, X30, plus E08, H05, X06, H16, and X21. The Hindi and Hinglish wording retains app, file, and search terms as spoken, while the expected action is checked against the PC tool schema. Mixed requests are escalated; bulk deletion and security-setting requests are unsafe; single-file deletion is Tier 2 and must confirm.
