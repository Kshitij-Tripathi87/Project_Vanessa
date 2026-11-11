from pathlib import Path
from typing import Any
import sys
sys.path.insert(0, '.')
from scripts.benchmark_models import run_benchmark
import time
import json
import os
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


def run_single_inference(model_path: str, request: dict[str, Any]) -> dict[str, Any] | None:
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


# Model configurations
MODELS = [
    {
        "name": "qwen3-0.6b",
        "path": "models/qwen3-0.6b/Qwen3-0.6B-Q4_0.gguf",
    },
    {
        "name": "qwen2.5-0.5b",
        "path": "models/qwen2.5-0.5b/qwen2.5-0.5b-instruct-q4_0.gguf",
    },
    {
        "name": "lfm2-350m",
        "path": "models/lfm2-350m/LFM2-350M-Q4_0.gguf",
    },
    {
        "name": "lfm2-700m",
        "path": "models/lfm2-700m/LFM2-700M-Q4_0.gguf",
    },
    {
        "name": "llama-3.2-1b",
        "path": "models/llama-3.2-1b/Llama-3.2-1B-Instruct-Q4_0.gguf",
    },
]

GOLD_PATH = Path('evaluation/golden_eval_v2.jsonl')
MAX_SAMPLES = 5


def main():
    gold_rows_all = read_jsonl(GOLD_PATH)
    gold_rows = gold_rows_all[:MAX_SAMPLES]
    
    print(f'Testing {MAX_SAMPLES} samples from golden set across {len(MODELS)} models')
    print('='*70)
    
    all_reports = {}
    
    for model in MODELS:
        model_name = model["name"]
        model_path = Path(model["path"])
        
        if not model_path.exists():
            print(f'\n Model file not found at {model_path}')
            continue
        
        print(f'\n Testing {model_name}')
        print(f'   File: {model_path}')
        
        predictions = []
        latencies = []
        failed = 0
        
        for i, row in enumerate(gold_rows):
            request = row["input"]
            
            start_time = time.perf_counter()
            prediction = run_single_inference(str(model_path), request)
            latency = time.perf_counter() - start_time
            latencies.append(latency)
            
            if prediction:
                predictions.append({"id": row["id"], "prediction": prediction})
                print(f'  [{i+1}/{MAX_SAMPLES}] OK decision={prediction["decision"]}, cap={prediction.get("invocation", {}).get("capability_id", "N/A")}, lat={latency*1000:.0f}ms')
            else:
                failed += 1
                print(f'  [{i+1}/{MAX_SAMPLES}] Failed to parse JSON')
        
        # Evaluate
        print(f'  Evaluating {model_name}...')
        report = evaluate_v2(gold_rows, predictions)
        
        # Add performance metrics
        if latencies:
            sorted_lat = sorted(latencies)
            report['latency_p50'] = sorted_lat[len(sorted_lat) // 2]
            report['latency_p95'] = sorted_lat[int(len(latencies) * 0.95)]
            report['latency_mean'] = sum(latencies) / len(latencies)
        
        # Peak RAM approximation from model loading
        mem = os.popen('ps -o rss= -p ' + str(os.getpid())).read().strip()
        if mem:
            report['peak_rss_mb'] = int(mem) / 1024**2
        else:
            report['peak_rss_mb'] = os.path.getsize(model_path) / 1024 / 1024 * 10  # rough estimate
        
        all_reports[model_name] = report
        
        # Print summary
        print(f'  Decision accuracy: {report["decision_accuracy"]:.2%}')
        print(f'  Exact match: {report["exact_output_match_rate"]:.2%}')
        print(f'  Schema valid: {report["schema_valid_rate"]:.2%}')
        print(f'  Safe contract: {report["safe_contract_rate"]:.2%}')
        print(f'  p50 latency: {report.get("latency_p50", 0)*1000:.0f}ms')
        print(f'  p95 latency: {report.get("latency_p95", 0)*1000:.0f}ms')
        print(f'  Peak RAM: {report.get("peak_rss_mb", 0):.0f} MB')
        print(f'  Failed: {failed}/{MAX_SAMPLES}')
    
    # Print comparison table
    print()
    print('COMPARISON TABLE')
    print('='*70)
    print(f'{"Model":<20} {"Decision Acc":<14} {"Exact Match":<14} {"Schema Valid":<14} {"p50 Latency":<14} {"Peak RAM":<10} {"Failed":<8}')
    print('-'*70)
    for name, report in all_reports.items():
        print(f'{name:<20} {report["decision_accuracy"]:<14.2%} {report["exact_output_match_rate"]:<14.2%} '
              f'{report["schema_valid_rate"]:<14.2%} {report.get("latency_p50", 0)*1000:<14.0f}ms {report.get("peak_rss_mb", 0):<10.0f}MB {report.get("failed_predictions", 0):<8}')
    
    # Save reports
    output_path = Path('evaluation/benchmark_full_report.json')
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open('w') as f:
        json.dump(all_reports, f, indent=2)
    
    print()
    print(f'Report saved to: evaluation/benchmark_full_report.json')
    print('='*70)


if __name__ == "__main__":
    main()