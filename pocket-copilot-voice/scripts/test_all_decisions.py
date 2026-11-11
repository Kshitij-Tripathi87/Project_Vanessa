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

llm = Llama(model_path='models/qwen2.5-0.5b/qwen2.5-0.5b-instruct-q4_0.gguf', n_ctx=4096, n_gpu_layers=0, verbose=False)

# Test all 5 decision types
test_cases = [
    ('Search for benchmark files in my Research Project', 'filesystem.search, workspace.list_approved', 'invoke_capability'),
    ('Open this webpage', 'browser.open_url, workspace.list_approved', 'invoke_capability'),
    ('What workspaces do I have approved?', 'workspace.list_approved', 'invoke_capability'),
    ('I need to run the test suite', 'project.run_tests', 'delegate_task'),
    ('What did you say? I did not understand', '', 'clarify'),
    ('I cannot do that', '', 'refuse'),
    ('Stop the execution', '', 'no_action'),
]

print('Testing all 5 decision types with qwen2.5-0.5b...')
print('='*60)

for transcript, caps, expected_decision in test_cases:
    start = time.time()
    prompt = make_prompt(transcript, caps)
    output = llm.create_completion(prompt, temperature=0.1, top_p=0.95, max_tokens=512)
    latency = time.time() - start
    
    text = output['choices'][0]['text']
    s = text.find('{')
    e = text.rfind('}')
    parsed = None
    if s >= 0 and e > s:
        try:
            parsed = json.loads(text[s:e+1])
        except:
            pass
    
    decision = parsed.get('decision') if parsed else None
    cap_id = parsed.get('invocation', {}).get('capability_id', None) if parsed else None
    valid = parsed is not None and parsed.get('schema_version') == 'pocket-copilot.action/v2'
    
    status = 'PASS' if (decision == expected_decision and valid) else 'FAIL'
    print(f'{status} Transcript: {transcript[:50]}... | Expected: {expected_decision} | Got: {decision} | Valid JSON: {valid} | Cap: {cap_id} | Latency: {latency*1000:.0f}ms')

print()
print('All decision types tested!')