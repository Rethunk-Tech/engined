---
name: Bug report
about: Report incorrect engined behaviour
title: '[BUG] '
labels: bug
assignees: ''
---

## Describe the bug

What went wrong? Include which engine, route (chat, embeddings, speech,
transcription, images), or config key was involved.

## To reproduce

1. The `[[engine]]`, `[[upstream]]`, and `[[route]]` entries involved
   (`config.toml`, redacted of secrets)
2. The request sent (curl command or client call)
3. Observed output or error, including the HTTP status and any provenance
   line engined logged

## Expected behaviour

What should have happened?

## Environment

- OS / GPU:
- Docker version:
- Bun version:
- engined version/commit:

## Additional context

Anything else relevant. Do not paste prompt or response content — engined
never logs it, and this report should not either.
