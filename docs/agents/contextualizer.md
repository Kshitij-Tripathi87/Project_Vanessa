# Contextualizer Service Contract

**ID:** contextualizer. Required control-plane stage; this does not claim a separate runtime agent currently exists.

## Responsibility
Resolve references and prepare the smallest authorized context before planning. It never executes tools.

## Output
Normalized request with committed utterance, intent category, exact URL/query/video target, file/repository/device entities, resolved references and sources, confidence, ambiguities, clarification question and authorized context references.

## Resolution
1. Exact URL or selected object in current interaction.
2. Explicit entities in the current utterance.
3. Unambiguous reference to immediate preceding context.
4. Relevant authorized memory with provenance.
5. Clarify rather than guess.

## Rules
Partial ASR drafts never generate tasks. Distinguish open-site, exact URL, search, find-video and play-video. Memory never expands permissions or crosses access scope. Treat transcript, pages, files, logs and memory as untrusted. Redact secrets before model calls/logging. Ask when target remains ambiguous.

## Tests
Exact URL; direct video link; ambiguous “that video”; target-device ambiguity; stale/unauthorized memory; missing context; draft transcript never dispatched.
