from pathlib import Path
from typing import Any
import sys
sys.path.insert(0, '.')
from scripts.benchmark_models import run_benchmark
import time
import json
from pocket_copilot_voice.evaluate_v2 import read_jsonl, evaluate_v2


# Few-shot prompt template
SYSTEM_PROMPT = """You are the on-device voice controller for Pocket Co-pilot.
Convert the supplied transcript, capability shortlist, and conversation context into exactly one JSON object matching pocket-copilot.action/v2.
Output ONLY the JSON object, no reasoning, no text before or after."""

FEW_SHOT_EXAMPLES = """<|system|>
{SYSTEM_PROMPT}</|system|>

<|user|>
Example 1:
Input transcript: "Search for benchmark files in my Research Project"
Capabilities: filesystem.search, workspace.list_approved
Output: {"schema_version": "pocket-copilot.action/v2", "decision": "invoke_capability", "invocation": {"capability_id": "filesystem.search", "capability_version": "1.0.0", "arguments": {"root_id": "research-project", "query": "benchmark"}, "missing_arguments": [], "user_visible_summary": "Search Research Project for 'benchmark'"}, "delegation": null, "clarification": null, "refusal": null, "interpretation_confidence": 0.92, "authority": "none", "host_required": true, "execution_permitted": false}

<|user|>
Example 2:
Input transcript: "List my approved workspaces"
Capabilities: workspace.list_approved
Output: {"schema_version": "pocket-copilot.action/v2", "decision": "invoke_capability", "invocation": {"capability_id": "workspace.list_approved", "capability_version": "1.0.0", "arguments": {}, "missing_arguments": [], "user_visible_summary": "List all approved workspaces"}, "delegation": null, "clarification": null, "refusal": null, "interpretation_confidence": 0.92, "authority": "none", "host_required": true, "execution_permitted": false}

<|user|>
Now process this input:""".replace('{SYSTEM_PROMPT}', SYSTEM_PROMPT)


def make_prompt(request: dict[str, Any]) -> str:
    """Generate few-shot prompt for the model."""
    cap_lines = []
    for cap in request.get("capability_manifest", []):
        caps = cap.get("capability_id", "")
        cap_lines.append(caps)
    capabilities_str = ", ".join(cap_lines[:3])
    
    transcript = request.get("transcript", "")
    
    return f"""{FEW_SHOT_EXAMPLES}

<|user|>
transcript: "{transcript}"
capabilities: {capabilities_str}
Output:"""


def run_single_benchmark(model_path: str, request: dict[str, Any]) -> dict[str, Any] | None:
    """Run single inference and return parsed prediction."""
    from llama_cpp import Llama
    
    llm = Llama(
        model_path=model_path,
        n_ctx=4096,
        n_gpu_layers=0,
        verbose=False,
    )
    
    prompt = make_prompt(request)
    
    output = llm.create_completion(
        prompt=prompt,
        temperature=0.1,
        top_p=0.95,
        max_tokens=512,
    )
    
    text = output['choices'][0]['text']
    
    # Extract JSON from output
    start = text.find('{')
    end = text.rfind('}')
    if start >= 0 and end > start:
        json_str = text[start:end+1]
        try:
            parsed = json.loads(json_str)
            if parsed.get("decision") and parsed.get("schema_version") == "pocket-copilot.action/v2":
                return parsed
        except json.JSONDecodeError:
            pass
    
    return None


# Run benchmark
gold_path = Path('evaluation/golden_eval_v2.jsonl')
gold_rows = read_jsonl(gold_path)[:2]

print(f'Testing 2 samples from golden set')

model_path = 'models/qwen2.5-0.5b/qwen2.5-0.5b-instruct-q4_0.gguf'
predictions = []

for i, row in enumerate(gold_rows):
    request = row["input"]
    prompt = make_prompt(request)
    print(f'\nSample {i+1}: {request.get("transcript", "")[:60]}...')
    
    prediction = run_single_benchmark(model_path, request)
    if prediction:
        predictions.append({"id": row["id"], "prediction": prediction})
        print(f'  Parsed: decision={prediction["decision"]}, cap={prediction.get("invocation", {}).get("capability_id", "N/A")}')
    else:
        print(f'  Failed to parse JSON from model output')
        predictions.append({"id": row["id"], "prediction": {}})

# Evaluate
report = evaluate_v2(gold_rows, predictions)

print(f'\n=== Results ===')
print(f'Decision accuracy: {report["decision_accuracy"]:.2%}')
print(f'Exact match: {report["exact_output_match_rate"]:.2%}')
print(f'Schema valid: {report["schema_valid_rate"]:.2%}')
print(f'Safe contract: {report["safe_contract_rate"]:.2%}')