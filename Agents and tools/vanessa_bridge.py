#!/usr/bin/env python3
"""Vanessa <-> OpenJarvis Integration Bridge.

Enables Vanessa Voice & Desktop Orchestrator to control OpenJarvis:
- Full system execution (shell_exec, repl)
- File operations (file_read, file_write, apply_patch)
- Git operations (git_status, git_diff, git_commit, git_log)
- Browser automation (browser_navigate, browser_screenshot, browser_extract)
- Everyday scheduled tasks (create, list, cancel)
- Intelligence Brain (NVIDIA NIM with safe placeholder fallback)
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any, Dict

# Ensure src is on sys.path
SCRIPT_DIR = Path(__file__).resolve().parent
SRC_DIR = SCRIPT_DIR / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

import openjarvis.tools  # Trigger tool registration
from openjarvis.core.registry import ToolRegistry
from openjarvis.scheduler.store import SchedulerStore
from openjarvis.scheduler.scheduler import TaskScheduler


def get_scheduler_store() -> SchedulerStore:
    db_path = Path.home() / ".openjarvis" / "scheduler.db"
    return SchedulerStore(db_path)


def handle_run_tool(tool_name: str, params: Dict[str, Any]) -> Dict[str, Any]:
    if not ToolRegistry.contains(tool_name):
        return {
            "success": False,
            "error": f"Tool '{tool_name}' not found. Available: {list(ToolRegistry.keys())}",
        }

    try:
        tool = ToolRegistry.create(tool_name)
        result = tool.execute(**params)
        return {
            "success": getattr(result, "success", True),
            "tool": tool_name,
            "output": getattr(result, "content", str(result)),
            "metadata": getattr(result, "metadata", {}),
        }
    except Exception as e:
        return {"success": False, "tool": tool_name, "error": str(e)}


def handle_schedule_list() -> Dict[str, Any]:
    store = get_scheduler_store()
    try:
        tasks = store.list_tasks()
        return {
            "success": True,
            "count": len(tasks),
            "tasks": tasks,
        }
    except Exception as e:
        return {"success": False, "error": str(e)}
    finally:
        store.close()


def handle_schedule_create(prompt: str, schedule_type: str = "cron", schedule_value: str = "0 9 * * *", tools: str = "shell_exec,file_read,file_write,git_status") -> Dict[str, Any]:
    store = get_scheduler_store()
    try:
        scheduler = TaskScheduler(store)
        task = scheduler.create_task(
            prompt=prompt,
            schedule_type=schedule_type,
            schedule_value=schedule_value,
            agent="simple",
            tools=tools,
        )
        return {
            "success": True,
            "task_id": task.id,
            "prompt": prompt,
            "schedule": f"{schedule_type}: {schedule_value}",
            "next_run": task.next_run,
            "tools": tools,
        }
    except Exception as e:
        return {"success": False, "error": str(e)}
    finally:
        store.close()


def handle_status() -> Dict[str, Any]:
    tools = list(ToolRegistry.keys())
    store = get_scheduler_store()
    scheduled = store.list_tasks()
    
    nvidia_key = os.environ.get("NVIDIA_API_KEY", "")
    is_placeholder = "placeholder" in nvidia_key.lower() or not nvidia_key

    return {
        "success": True,
        "brain": {
            "provider": "NVIDIA NIM",
            "model": os.environ.get("NVIDIA_MODEL", "meta/llama-3.3-70b-instruct"),
            "endpoint": os.environ.get("NVIDIA_BASE_URL", "https://integrate.api.nvidia.com/v1"),
            "is_placeholder_key": is_placeholder,
            "status": "ready_with_fallback" if is_placeholder else "active",
        },
        "tools": {
            "total_registered": len(tools),
            "sample_tools": [
                "shell_exec", "file_read", "file_write", "git_status",
                "browser_navigate", "browser_screenshot", "web_search",
                "code_interpreter", "audio_transcribe", "text_to_speech"
            ],
        },
        "scheduler": {
            "active_tasks": len(scheduled),
            "everyday_schedule": "0 9 * * *",
        },
    }


def handle_ask(query: str) -> Dict[str, Any]:
    raw_key = os.environ.get("NVIDIA_API_KEY", "") or os.environ.get("PLANNER_API_KEY", "")
    nvidia_key = raw_key.strip("'\" \t\r\n")
    is_placeholder = "placeholder" in nvidia_key.lower() or not nvidia_key

    if not is_placeholder:
        try:
            import urllib.request
            base_url = os.environ.get("NVIDIA_BASE_URL", "https://integrate.api.nvidia.com/v1")
            model = os.environ.get("NVIDIA_MODEL", "nvidia/nemotron-3-ultra-550b-a55b").strip()
            req_data = json.dumps({
                "model": model,
                "messages": [
                    {"role": "system", "content": "You are Vanessa, a brilliant, charismatic AI assistant on Windows. Answer concisely, intelligently, and charismatically. Do not use markdown formatting (no asterisks, hashes, or bullets). Keep answers under 25 words unless asked for details."},
                    {"role": "user", "content": query}
                ],
                "max_tokens": 150,
                "temperature": 0.3
            }).encode("utf-8")
            req = urllib.request.Request(
                f"{base_url}/chat/completions",
                data=req_data,
                headers={"Content-Type": "application/json", "Authorization": f"Bearer {nvidia_key}"}
            )
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                content = data["choices"][0]["message"]["content"]
                return {"success": True, "content": content.strip(), "mode": "nvidia_nim_nemotron"}
        except Exception:
            try:
                from openjarvis.sdk import Jarvis
                jarvis = Jarvis()
                content = jarvis.ask(query)
                return {"success": True, "content": content, "mode": "nvidia_nim_sdk"}
            except Exception:
                pass

    lower = query.lower()
    if "status" in lower or "diagnostic" in lower:
        res = handle_run_tool("shell_exec", {"command": "echo Vanessa Status: Operational && git status --short"})
        return {
            "success": True,
            "content": f"Vanessa system diagnostics operational:\n{res.get('output', '')}",
            "mode": "diagnostic_result",
        }
    return {
        "success": True,
        "content": f"I am Vanessa, online and ready to control your system, execute tasks, or answer questions.",
        "mode": "vanessa_ready",
    }


import base64

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No action provided"}))
        sys.exit(1)

    action = sys.argv[1]
    
    # Optional JSON payload from argv[2]
    payload: Dict[str, Any] = {}
    if len(sys.argv) > 2:
        if sys.argv[2] == "--stdin":
            try:
                payload = json.loads(sys.stdin.read())
            except Exception:
                pass
        elif sys.argv[2] == "--b64" and len(sys.argv) > 3:
            try:
                decoded = base64.b64decode(sys.argv[3]).decode("utf-8")
                payload = json.loads(decoded)
            except Exception as e:
                payload = {"error": f"Base64 parse error: {e}"}
        else:
            try:
                payload = json.loads(sys.argv[2])
            except Exception:
                payload = {"arg": sys.argv[2]}

    if action == "status":
        res = handle_status()
    elif action == "run_tool":
        tool_name = payload.get("tool") or payload.get("name") or "shell_exec"
        params = payload.get("params", {})
        res = handle_run_tool(tool_name, params)
    elif action == "schedule_list":
        res = handle_schedule_list()
    elif action == "schedule_create":
        prompt = payload.get("prompt", "Everyday morning system update and health check")
        sched_type = payload.get("type", "cron")
        sched_val = payload.get("value", "0 9 * * *")
        tools = payload.get("tools", "shell_exec,file_read,file_write,git_status")
        res = handle_schedule_create(prompt, sched_type, sched_val, tools)
    elif action == "ask":
        query = payload.get("query") or payload.get("command") or payload.get("arg", "")
        res = handle_ask(query)
    else:
        res = {"success": False, "error": f"Unknown action: {action}"}

    print(json.dumps(res, indent=2))


if __name__ == "__main__":
    main()
