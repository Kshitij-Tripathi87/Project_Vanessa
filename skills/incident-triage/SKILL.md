---
name: incident-triage
description: Triage production errors, correlate with runbooks and memory, apply patch in isolated branch, and run regression tests with zero automated deployment
agent: coding
---

# Incident Triage Skill

## Objective
Investigate service incidents (e.g. 500 error in checkout), inspect runbooks, create an isolated fix branch, run regression tests, and block production deployment.

## Invariant
Never deploy directly to production. Automated deployment is strictly refused per safety policy.
