from llama_cpp import Llama
import json

llm = Llama(
    model_path='models/qwen2.5-0.5b/qwen2.5-0.5b-instruct-q4_0.gguf',
    n_ctx=4096,
    n_gpu_layers=0,
    verbose=False,
)

SYSTEM_PROMPT = """You are the on-device voice controller for Pocket Co-pilot. 
Convert the supplied transcript, capability shortlist, and conversation context into exactly one JSON object matching pocket-copilot.action/v2.
Output ONLY the JSON object, no reasoning, no text before or after."""

# Few-shot prompt with examples
prompt = f"""<|system|>
{SYSTEM_PROMPT}</|system|>

<|user|>
Example 1:
Input transcript: "Search for benchmark files in my Research Project"
Capabilities: filesystem.search, workspace.list_approved
Output: {{
  "schema_version": "pocket-copilot.action/v2",
  "decision": "invoke_capability",
  "invocation": {{
    "capability_id": "filesystem.search",
    "capability_version": "1.0.0",
    "arguments": {{"root_id": "research-project", "query": "benchmark"}},
    "missing_arguments": [],
    "user_visible_summary": "Search Research Project for 'benchmark'"
  }},
  "delegation": null,
  "clarification": null,
  "refusal": null,
  "interpretation_confidence": 0.92,
  "authority": "none",
  "host_required": true,
  "execution_permitted": false
}}

<|user|>
Example 2:
Input transcript: "List my approved workspaces"
Capabilities: workspace.list_approved
Output: {{
  "schema_version": "pocket-copilot.action/v2",
  "decision": "invoke_capability",
  "invocation": {{
    "capability_id": "workspace.list_approved",
    "capability_version": "1.0.0",
    "arguments": {{}},
    "missing_arguments": [],
    "user_visible_summary": "List all approved workspaces"
  }},
  "delegation": null,
  "clarification": null,
  "refusal": null,
  "interpretation_confidence": 0.92,
  "authority": "none",
  "host_required": true,
  "execution_permitted": false
}}

<|user|>
Now process this input:
transcript: "Search for benchmark files in my Research Project"
capabilities: filesystem.search, workspace.list_approved
Output:""".strip()

output = llm.create_completion(
    prompt=prompt,
    temperature=0.1,
    top_p=0.95,
    max_tokens=512,
)
text = output['choices'][0]['text']
print('Output:', text)
print('---')
# Extract JSON
start = text.find('{')
end = text.rfind('}')
if start >= 0 and end > start:
    json_str = text[start:end+1]
    try:
        parsed = json.loads(json_str)
        print('Parsed successfully!')
        print('decision:', parsed.get('decision'))
        print('capability_id:', parsed.get('invocation', {}).get('capability_id'))
    except json.JSONDecodeError as e:
        print('JSON parse error:', e)