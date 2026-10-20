---
name: remember-preferences
description: Persist long-term facts and preferences to SQLite Memory Palace with 30-day retention and redact secrets
agent: memory
---

# Remember Preferences Skill

## Objective
Store and recall user preferences, recent jobs, and runbook solutions.

## Invariant
Never store API keys, passwords, or authentication secrets. Sensitive tokens must be redacted prior to writing.
