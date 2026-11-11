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
Now process this input:'''

def make_prompt(transcript, capabilities):
    return FEW_SHOT_EXAMPLES.replace('Now process this input:', f'transcript: "{transcript}"\\ncapabilities: {capabilities}\\nOutput:')

# Test Qwen2.5
print('Testing Qwen2.5-0.5B...')
llm = Llama(model_path='models/qwen2.5-0.5b/qwen2.5-0.5b-instruct-q4_0.gguf', n_ctx=4096, n_gpu_layers=0, verbose=False)

prompt = make_prompt('Search for benchmark files in my Research Project', 'filesystem.search, workspace.list_approved')
start = time.time()
output = llm.create_completion(prompt, temperature=0.1, top_p=0.95, max_tokens=512)
latency = time.time() - start

text = output['choices'][0]['text']
start_j = text.find('{')
end_j = text.rfind('}')
parsed = None
if start_j >= 0 and end_j > start_j:
    try:
        parsed = json.loads(text[start_j:end_j+1])
    except: pass

print(f'  Latency: {latency*1000:.0f}ms')
print(f'  Decision: {parsed.get("decision") if parsed else "N/A"}')
print(f'  Capability: {parsed.get("invocation", {}).get("capability_id") if parsed else "N/A"}')
print(f'  Valid JSON: {parsed is not None}')

# Test LFM2-350M
print('Testing LFM2-350M...')
llm2 = Llama(model_path='models/lfm2-350m/LFM2-350M-Q4_0.gguf', n_ctx=4096, n_gpu_layers=0, verbose=False)

prompt2 = make_prompt('Open my research project', 'project.run_tests, workspace.list_approved')
start2 = time.time()
output2 = llm2.create_completion(prompt2, temperature=0.1, top_p=0.95, max_tokens=512)
latency2 = time.time() - start2

text2 = output2['choices'][0]['text']
start_j2 = text2.find('{')
end_j2 = text2.rfind('}')
parsed2 = None
if start_j2 >= 0 and end_j2 > start_j2:
    try:
        parsed2 = json.loads(text2[start_j2:end_j2+1])
    except: pass

print(f'  Latency: {latency2*1000:.0f}ms')
print(f'  Decision: {parsed2.get("decision") if parsed2 else "N/A"}')
print(f'  Capability: {parsed2.get("invocation", {}).get("capability_id") if parsed2 else "N/A"}')
print(f'  Valid JSON: {parsed2 is not None}')

print()
print('Both models tested successfully!')