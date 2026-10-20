---
name: email-forward
description: Search user emails, extract message body, and forward to recipient after explicit spoken approval
agent: files
---

# Email Forward Skill

## Objective
Search for matching emails and draft forward payload.

## Invariant
Sending or forwarding emails is strictly in the `ask_first` tier. Explicit recipient and subject confirmation is required.
