# Third-party notices

engined is MIT-licensed. It stands on the projects below. Most are fetched
when an engine image is built or a model is obtained, not copied into this
repository; the licence of each still governs the image or file it produces.
An image built from `engines/` is not MIT as a whole when it contains a
GPL-3.0 component, and a model is usable only on its own terms.

## Engine sources

| Project | Licence | How engined uses it |
| --- | --- | --- |
| [llama.cpp](https://github.com/ggml-org/llama.cpp) | MIT | Chat, embedding and FIM engine, via the fork below |
| [PrismML-Eng/llama.cpp](https://github.com/PrismML-Eng/llama.cpp) | MIT | Source `engines/llama/Dockerfile` clones at a pinned commit |
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp) | MIT | Transcription engine; `ghcr.io/ggml-org/whisper.cpp` is the base layer of `engines/whisper/Dockerfile` |
| [ComfyUI](https://github.com/comfyanonymous/ComfyUI) | GPL-3.0 | Image engine, cloned at a pinned tag by `engines/comfy/Dockerfile` |
| [Chatterbox](https://github.com/resemble-ai/chatterbox) | MIT | TTS library, by Resemble AI |
| [devnen/chatterbox-v2](https://github.com/devnen/chatterbox-v2) | MIT | Chatterbox fork installed by `engines/chatterbox-shared/Dockerfile` |
| [Perth](https://github.com/resemble-ai/Perth) (`resemble-perth`) | MIT | Chatterbox's audio watermarker, installed from a pinned upstream commit |
| [devnen/Chatterbox-TTS-Server](https://github.com/devnen/Chatterbox-TTS-Server) | MIT | Reference for the Chatterbox images' system and model setup |
| [Kokoro](https://github.com/hexgrad/kokoro) | Apache-2.0 | TTS library installed by `engines/kokoro/Dockerfile`; pulls in [misaki](https://github.com/hexgrad/misaki) (Apache-2.0) |
| [piper1-gpl](https://github.com/OHF-Voice/piper1-gpl) (`piper-tts`) | GPL-3.0-or-later | TTS library installed by `engines/piper/Dockerfile` |
| [PyTorch](https://github.com/pytorch/pytorch) | BSD-3-Clause | ROCm wheels in the Chatterbox, Kokoro and ComfyUI images |
| [FastAPI](https://github.com/fastapi/fastapi), [Uvicorn](https://github.com/encode/uvicorn) | MIT, BSD-3-Clause | HTTP wrappers in the Python engine images |
| [uv](https://github.com/astral-sh/uv) | Apache-2.0 or MIT | Venv tooling copied into image build stages |
| [ROCm](https://github.com/ROCm/ROCm) (`rocm/dev-ubuntu-24.04`) | Per component, mostly MIT and Apache-2.0 | Base image for the ROCm engines |
| [Fedora](https://fedoraproject.org), [Python](https://www.python.org) images | Per package | Base images for the llama and piper engines |

`engines/llama/llama-grammar.patch`, which raises llama.cpp's
`MAX_REPETITION_THRESHOLD` for large tool schemas, is KYmidnight's, from
[kyuz0/amd-strix-halo-toolboxes#70](https://github.com/kyuz0/amd-strix-halo-toolboxes/issues/70).

## Models

Each is fetched by an engine's image build or by the `obtain` command in its
`spec.toml`; none is stored in this repository.

| Model | Licence | Engine |
| --- | --- | --- |
| [Whisper ggml conversions](https://huggingface.co/ggerganov/whisper.cpp) | MIT | whisper |
| [Silero VAD, ggml](https://huggingface.co/ggml-org/whisper-vad) | MIT | whisper |
| [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) | Apache-2.0 | kokoro |
| [Chatterbox](https://huggingface.co/ResembleAI/chatterbox) | MIT | chatterbox-en, chatterbox-multi |
| [Piper `en_US-lessac-medium`](https://huggingface.co/rhasspy/piper-voices/tree/main/en/en_US/lessac/medium) | Trained on the [Blizzard 2013 Lessac data](https://www.cstr.ed.ac.uk/projects/blizzard/2013/lessac_blizzard2013/license.html), a **research licence** | piper |

The Piper voice is baked into the piper image at build time. Check that its
dataset licence covers your use, or set the `PIPER_VOICE` and
`PIPER_VOICE_BASE` build args to a voice whose licence does.

GGUF chat models are chosen by the operator in `config.toml`; each carries its
own licence.

## Agentic CLIs

The `claude`, `opencode` and `cursor` engines run each vendor's own CLI under
the operator's own account and are governed by that vendor's terms. engined
ships none of them. Claude is a trademark of Anthropic, and Cursor a
trademark of Anysphere.

## Development tooling

Not part of what engined ships: [Bun](https://github.com/oven-sh/bun) (MIT),
[TypeScript](https://github.com/microsoft/TypeScript) (Apache-2.0),
[Biome](https://github.com/biomejs/biome) (MIT or Apache-2.0),
[knip](https://github.com/webpro-nl/knip) (ISC),
[Turborepo](https://github.com/vercel/turborepo) (MIT).
