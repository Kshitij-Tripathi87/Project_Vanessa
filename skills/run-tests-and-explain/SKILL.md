---
name: run-tests-and-explain
description: Execute test suites, capture process exit codes, and summarize failures in two plain sentences
agent: ide
---

# Run Tests and Explain Skill

## Objective
Run project test commands, verify exit code, and provide clear truthful summary.

## Invariant
Opening a terminal is NOT proof of testing. The test suite command must complete with `exitCode === 0` and verified assertion output.
