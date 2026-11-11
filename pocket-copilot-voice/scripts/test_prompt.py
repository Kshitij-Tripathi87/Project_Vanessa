from llama_cpp import Llama
import json

llm = Llama(
    model_path='models/qwen2.5-0.5b/qwen2.5-0.5b-instruct-q4_0.gguf',
    n_ctx=4096,
    n_gpu_layers=0,
    verbose=False,
)

# Try with a more explicit prompt format with examples
prompt = """You are a voice command interpreter. Output ONLY valid JSON matching pocket-copilot.action/v2.

Input:
{
  "transcript": "Search for benchmark files in my Research Project",
  "capabilities": ["filesystem.search", "workspace.list_approved"]
}

Output:
{
  "schema_version": "pocket-copilot.action/v2",
  "decision": "invoke_capability",
  "invocation": {
    "capability_id": "filesystem.search",
    "capability_version": "1.0.0",
    "arguments": {"root_id": "research-project", "query": "benchmark"},
    "missing_arguments": [],
    "user_visible_summary": "Search Research Project for 'benchmark'"
  },
  "delegation": null,
  "clarification": null,
  "refusal": null,
  "interpretation_confidence": 0.92,
  "authority": "none",
  "host_required": true,
  "execution_permitted": false
}

Now process this input:
{
  "transcript": "Open my Research Project, find the benchmark files and tell me what is inside",
  "capabilities": ["filesystem.search", "workspace.list_approved", "filesystem.read_text"]
}

Output:"""

output = llm.create_completion(
    prompt=prompt,
    temperature=0.1,
    top_p=0.95,
    max_tokens=512,
    stop=['\n\n', 'Input:'],
)
print('Output:', output['choices'][0]['text'])