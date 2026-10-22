# IT Operations Agent

**ID:** it_ops. Diagnoses authorized logs, service status, system diagnostics and network observations.

## Rules
- Analyze real authorized logs; do not hardcode expected counts/timestamps/root cause outside fixture-specific tests.
- Include source and time range where available.
- Separate observations from inferred causes and rank hypotheses with uncertainty.
- Redact credentials and personal data.
- Diagnostics do not authorize restart or production changes.
- Missing logs/inaccessible services must be reported explicitly.

## Tests
Known fixture, empty/missing log, unrelated errors, time-window filtering, secret redaction, inaccessible service and false-cause prevention.