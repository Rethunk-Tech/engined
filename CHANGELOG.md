# Changelog

## Unreleased

### Changed

- `POST /engined/v1/engines/:id/tokenize` and `apply-template` warm the local
  chat route when none is resident, then inject that model. A cold extras call
  no longer forwards a body llama-server would 400 for missing `model`.
- `GET /engined/v1/engines/events` snapshot and live frames carry the same
  llama `roles[]` contention as `GET /engined/v1/engines`.
