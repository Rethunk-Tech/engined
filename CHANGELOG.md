# Changelog

## Unreleased

### Changed

- `POST /engined/v1/engines/:id/tokenize` and `apply-template` warm the local
  chat route when none is resident, then inject that model. A cold extras call
  no longer forwards a body llama-server would 400 for missing `model`.
