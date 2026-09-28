# Changelog

## 0.1.0 (unreleased)

First public release.

### Door

- One OpenAI-shaped door on loopback for chat, embeddings, speech,
  transcription and images; consumers name a `model`, engined picks the engine.
- Engines start on demand, hold one resident model per role, and stop when
  idle. Chains fall back across engines and record which one answered.
- Fill-in-the-middle over llama.cpp's `/infill`, a vision bridge that captions
  an image for a text-only route, token counting from a GGUF's own vocabulary
  without loading weights, and per-day usage totals that keep no request
  content.
- `config.d/*.toml` fragments beside `config.toml`, picked up on reload, so a
  tool can add an engine and its routes for the length of a run and remove
  them after.
- `x-engined-queue-ms` on chat and completions: how long the call waited for
  a llama slot, separate from how long it took.
- A streamed llama answer whose caller stops reading is cut after
  `stream_stall_seconds` (default 60) so it cannot hold a slot forever; a
  slow model never trips it.
- Remote upstreams with keyring-held secrets, egress ceilings and extra
  request headers.

### Agentic engines

- `claude`, `opencode` and `cursor` as engines, each with writing disabled and
  a floor probe that re-proves it on every version change.

### Engines

- Shipped images for llama.cpp, whisper.cpp, ComfyUI, Chatterbox, Kokoro and
  Piper, optimised for AMD Strix Halo; any engine can point at another image
  through `spec_dir`.

### Licence

- MIT. Upstream projects and models are credited in
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
