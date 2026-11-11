from pathlib import Path
import json
from llama_cpp import Llama
import time

SYSTEM_PROMPT = 'You are the on-device voice controller for Pocket Co-pilot. Convert the supplied transcript, capability shortlist, and conversation context into exactly one JSON object matching pocket-copilot.action/v2. Output ONLY the JSON object, no reasoning, no text before or after.'

FEW_SHOT_EXAMPLES = '''<|system|>
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
Now process this input:
transcript: "{transcript}"
capabilities: {capabilities}
Output:
'''.replace('{SYSTEM_PROMPT}', SYSTEM_PROMPT)

def make_prompt(transcript, capabilities):
    return FEW_SHOT_EXAMPLES.replace('Now process this input:', f'transcript: "{transcript}"\\ncapabilities: {capabilities}\\nOutput:')

test_cases = [
    ('Search for benchmark files in my Research Project', 'filesystem.search, workspace.list_approved'),
    ('List my approved workspaces', 'workspace.list_approved'),
    ('What is the git status?', 'git.status, workspace.list_approved'),
]

models = [
    ('qwen2.5-0.5b', 'models/qwen2.5-0.5b/qwen2.5-0.5b-instruct-q4_0.gguf'),
    ('qwen3-0.6b', 'models/qwen3-0.6b/Qwen3-0.6B-Q4_0.gguf'),
    ('lfm2-350m', 'models/lfm2-350m/LFM2-350M-Q4_0.gguf'),
    ('lfm2-700m', 'models/lfm2-700m/LFM2-700M-Q4_0.gguf'),
    ('llama-3.2-1b', 'models/llama-3.2-1b/Llama-3.2-1B-Instruct-Q4_0.gguf'),
]

for model_name, model_path in models:
    p = Path(model_path)
    if not p.exists():
        print(f'{model_name}: File not found')
        continue
    print(f'\nTesting {model_name}...')
    llm = Llama(model_path=str(p), n_ctx=4096, n_gpu_layers=0, verbose=False)
    for transcript, caps in test_cases:
        start = time.time()
        prompt = make_prompt(transcript, caps)
        output = llm.create_completion(prompt, temperature=0.1, top_p=0.95, max_tokens=512)
        latency = time.time() - start
        
        text = output['choices'][0]['text']
        # Extract JSON
        s = text.find('{')
        e = text.rfind('}')
        parsed = None
        if s >= 0 and e > s:
            try:
                parsed = json.loads(text[s:e+1])
            except:
                pass
        
        decision = parsed.get('decision') if parsed else 'N/A'
        cap_id = parsed.get('invocation', {}).get('capability_id', 'N/A') if parsed else 'N/A'
        valid = parsed is not None and parsed.get('schema_version') == 'pocket-copilot.action/v2'
        
        print(f'  Transcript: {transcript[:50]}... | Cap: {caps}')
        print(f'    Latency: {latency*1000:.0f}ms | Decision: {decision} | Cap: {cap_id} | Valid JSON: {valid}')