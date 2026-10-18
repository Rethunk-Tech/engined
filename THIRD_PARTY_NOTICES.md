# Third-party notices

engined is MIT. Licences below govern the images and files they produce; an
`engines/` image with a GPL-3.0 component is not MIT as a whole. Models are
usable only on their own terms. Most are fetched at image build or `obtain`.

## Engine sources

| Project | Licence | How engined uses it |
| --- | --- | --- |
| [llama.cpp](https://github.com/ggml-org/llama.cpp) | MIT | Chat, embedding and FIM, via the fork below |
| [PrismML-Eng/llama.cpp](https://github.com/PrismML-Eng/llama.cpp) | MIT | `engines/llama/Dockerfile` clones a pinned commit |
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp) | MIT | `ghcr.io/ggml-org/whisper.cpp` is the `engines/whisper/Dockerfile` base |
| [ComfyUI](https://github.com/comfyanonymous/ComfyUI) | GPL-3.0 | Image engine, pinned tag in `engines/comfy/Dockerfile` |
| [Chatterbox](https://github.com/resemble-ai/chatterbox) | MIT | TTS library, Resemble AI |
| [devnen/chatterbox-v2](https://github.com/devnen/chatterbox-v2) | MIT | Installed by `engines/chatterbox-shared/Dockerfile` |
| [Perth](https://github.com/resemble-ai/Perth) (`resemble-perth`) | MIT | Chatterbox watermarker, pinned commit |
| [devnen/Chatterbox-TTS-Server](https://github.com/devnen/Chatterbox-TTS-Server) | MIT | Reference for Chatterbox image setup |
| [Kokoro](https://github.com/hexgrad/kokoro) | Apache-2.0 | `engines/kokoro/Dockerfile`; pulls [misaki](https://github.com/hexgrad/misaki) (Apache-2.0) |
| [eSpeak NG](https://github.com/espeak-ng/espeak-ng) | GPL-3.0-or-later | Kokoro image phonemizer for misaki G2P |
| [pykakasi](https://codeberg.org/miurahr/pykakasi) | GPL-3.0-or-later | Japanese romanisation; Chatterbox dep in `engines/chatterbox-shared/requirements.in` |
| [piper1-gpl](https://github.com/OHF-Voice/piper1-gpl) (`piper-tts`) | GPL-3.0-or-later | `engines/piper/Dockerfile` |
| [PyTorch](https://github.com/pytorch/pytorch) | BSD-3-Clause | ROCm wheels in Chatterbox, Kokoro, ComfyUI |
| [FastAPI](https://github.com/fastapi/fastapi), [Uvicorn](https://github.com/encode/uvicorn) | MIT, BSD-3-Clause | HTTP wrappers in the Python engine images |
| [uv](https://github.com/astral-sh/uv) | Apache-2.0 or MIT | Venv tooling in image build stages |
| [ROCm](https://github.com/ROCm/ROCm) (`rocm/dev-ubuntu-24.04`) | Per component, mostly MIT and Apache-2.0 | Base for the ROCm engines |
| [Fedora](https://fedoraproject.org), [Python](https://www.python.org) images | Per package | Base for llama and piper |

llama.cpp `MAX_REPETITION_THRESHOLD` in `engines/llama/Dockerfile` follows
[kyuz0/amd-strix-halo-toolboxes#70](https://github.com/kyuz0/amd-strix-halo-toolboxes/issues/70).

## Bundled libraries

| Project | Licence | How engined uses it |
| --- | --- | --- |
| [@decimalturn/toml-patch](https://github.com/DecimalTurn/toml-patch) 3.3.1 | MIT | Comment-preserving `config.toml` edits in `dist/main.js` |
| [Preact](https://github.com/preactjs/preact) 11 and [@preact/signals](https://github.com/preactjs/signals) 2 | MIT | Config UI in `dist/` |
| [CodeMirror 6](https://codemirror.net) and [@lezer/highlight](https://github.com/lezer-parser/highlight) | MIT | Raw `config.toml` editor in `dist/` |
| [Mermaid](https://github.com/mermaid-js/mermaid) 12 | MIT | Map view chunks (loaded on open). Deps: MIT, ISC, Apache-2.0 (Chevrotain), BSD-3-Clause (d3-ease, d3-sankey, rw), Unlicense (robust-predicates), Apache-2.0 (DOMPurify). [elkjs](https://github.com/kieler/elkjs) (EPL-2.0) ships unmodified as its own chunk |

## Models

Fetched by image build or `obtain` in `spec.toml`; none live in this repo.

| Model | Licence | Engine |
| --- | --- | --- |
| [Whisper ggml conversions](https://huggingface.co/ggerganov/whisper.cpp) | MIT | whisper |
| [Silero VAD, ggml](https://huggingface.co/ggml-org/whisper-vad) | MIT | whisper |
| [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) | Apache-2.0 | kokoro |
| [Chatterbox](https://huggingface.co/ResembleAI/chatterbox) | MIT | chatterbox-multi |
| [Chatterbox Turbo](https://huggingface.co/ResembleAI/chatterbox-turbo) | MIT | chatterbox-en |
| [MMS forced aligner](https://docs.pytorch.org/audio/stable/generated/torchaudio.pipelines.MMS_FA.html) (`torchaudio.pipelines.MMS_FA`) | [CC-BY-NC 4.0](https://github.com/facebookresearch/fairseq/tree/main/examples/mms#license), **non-commercial** | chatterbox-en, chatterbox-multi |
| [Piper `en_US-lessac-medium`](https://huggingface.co/rhasspy/piper-voices/tree/main/en/en_US/lessac/medium) | Trained on the [Blizzard 2013 Lessac data](https://www.cstr.ed.ac.uk/projects/blizzard/2013/lessac_blizzard2013/license.html), a **research licence** | piper |

The Piper voice is baked in. Confirm its dataset licence, or set
`PIPER_VOICE` and `PIPER_VOICE_BASE` to a voice yours covers.

The MMS aligner is baked into both Chatterbox images for word timestamps, so
those images as built are not licensed for commercial use.

GGUF chat models come from the operator's `config.toml` and carry their own
licence.

## Agentic CLIs

`claude`, `opencode`, and `cursor` run each vendor's CLI under the operator's
account and that vendor's terms. engined ships none of them. Claude is a
trademark of Anthropic; Cursor is a trademark of Anysphere.
