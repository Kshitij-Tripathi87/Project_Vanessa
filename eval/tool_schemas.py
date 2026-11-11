"""
Phase 1.1: Tool Schema Definitions

The 10 tools from Appendix A of the implementation plan.
These schemas will be loaded into the LLM as function definitions.
"""

TOOL_SCHEMAS = [
    {
        "name": "system_status",
        "description": "Get current PC system status (battery, CPU, disk, memory)",
        "parameters": {
            "type": "object",
            "properties": {
                "metric": {
                    "type": "string",
                    "enum": ["battery", "cpu", "disk", "memory", "all"],
                    "description": "Which metric to check, or 'all' for everything"
                }
            }
        },
        "tier": "T0",  # Auto - read-only
        "idempotent": True,
        "timeout": 5
    },
    {
        "name": "find_file",
        "description": "Search for files on the PC by name, type, folder, or modification date",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Search query (filename or content)"
                },
                "type": {
                    "type": "string",
                    "enum": ["pdf", "image", "video", "doc", "sheet", "any"],
                    "description": "File type filter"
                },
                "folder": {
                    "type": "string",
                    "enum": ["downloads", "documents", "desktop", "pictures", "videos", "any"],
                    "description": "Folder to search in"
                },
                "since": {
                    "type": "string",
                    "enum": ["today", "yesterday", "week", "month", "any"],
                    "description": "Time filter for modification date"
                }
            }
        },
        "tier": "T0",
        "idempotent": True,
        "timeout": 10
    },
    {
        "name": "open_app",
        "description": "Open an application on the PC",
        "parameters": {
            "type": "object",
            "properties": {
                "app": {
                    "type": "string",
                    "description": "Application name (chrome, vscode, spotify, excel, etc.)"
                }
            },
            "required": ["app"]
        },
        "tier": "T1",  # Auto, logged
        "idempotent": False,
        "timeout": 10
    },
    {
        "name": "open_url",
        "description": "Open a URL or search query in the default browser",
        "parameters": {
            "type": "object",
            "properties": {
                "target": {
                    "type": "string",
                    "description": "URL or site name (youtube, google, github.com, etc.)"
                },
                "query": {
                    "type": "string",
                    "description": "Search query if target is 'google' or similar"
                }
            },
            "required": ["target"]
        },
        "tier": "T1",
        "idempotent": False,
        "timeout": 10
    },
    {
        "name": "media_control",
        "description": "Control media playback (play, pause, next, previous)",
        "parameters": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["play", "pause", "next", "previous", "toggle"],
                    "description": "Media control action"
                }
            },
            "required": ["action"]
        },
        "tier": "T1",
        "idempotent": False,
        "timeout": 5
    },
    {
        "name": "set_volume",
        "description": "Control system volume",
        "parameters": {
            "type": "object",
            "properties": {
                "mode": {
                    "type": "string",
                    "enum": ["set", "up", "down", "mute", "unmute"],
                    "description": "Volume adjustment mode"
                },
                "level": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 100,
                    "description": "Target volume level (0-100) when mode is 'set'"
                }
            },
            "required": ["mode"]
        },
        "tier": "T1",
        "idempotent": False,
        "timeout": 5
    },
    {
        "name": "lock_pc",
        "description": "Lock the computer screen",
        "parameters": {
            "type": "object",
            "properties": {}
        },
        "tier": "T1",
        "idempotent": True,
        "timeout": 5
    },
    {
        "name": "take_screenshot",
        "description": "Take a screenshot of the screen or active window",
        "parameters": {
            "type": "object",
            "properties": {
                "target": {
                    "type": "string",
                    "enum": ["screen", "active_window"],
                    "description": "What to capture"
                }
            }
        },
        "tier": "T1",
        "idempotent": False,
        "timeout": 5
    },
    {
        "name": "open_file",
        "description": "Open a specific file with its default application",
        "parameters": {
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "File name or path"
                },
                "folder": {
                    "type": "string",
                    "enum": ["downloads", "documents", "desktop", "pictures", "videos", "any"],
                    "description": "Folder to look in"
                }
            },
            "required": ["name"]
        },
        "tier": "T1",
        "idempotent": False,
        "timeout": 10
    },
    {
        "name": "delete_file",
        "description": "Delete a file (REQUIRES CONFIRMATION - Tier 2)",
        "parameters": {
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "File name to delete"
                },
                "folder": {
                    "type": "string",
                    "enum": ["downloads", "documents", "desktop", "pictures", "videos"],
                    "description": "Folder containing the file"
                }
            },
            "required": ["name"]
        },
        "tier": "T2",  # Confirm - destructive
        "idempotent": True,
        "timeout": 5
    },
    {
        "name": "escalate",
        "description": "Escalate to PC brain for complex queries, multi-step tasks, or unsupported commands",
        "parameters": {
            "type": "object",
            "properties": {
                "reason": {
                    "type": "string",
                    "enum": ["chat", "multi_step", "unsupported", "unsafe", "unclear"],
                    "description": "Why escalation is needed"
                }
            },
            "required": ["reason"]
        },
        "tier": "T0",
        "idempotent": True,
        "timeout": 5
    }
]

def get_tool_by_name(name: str):
    """Get tool schema by name"""
    for tool in TOOL_SCHEMAS:
        if tool["name"] == name:
            return tool
    return None

def get_openai_format_tools():
    """Convert to OpenAI function calling format"""
    return [
        {
            "type": "function",
            "function": {
                "name": tool["name"],
                "description": tool["description"],
                "parameters": tool["parameters"]
            }
        }
        for tool in TOOL_SCHEMAS
    ]
