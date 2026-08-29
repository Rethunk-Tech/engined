"""Thin HTTP wrapper around Chatterbox Turbo for the sagaforge AudioAdapter
contract (packages/daemon/src/adapters/audio/chatterbox.ts): POST /v1/tts,
JSON in, newline-delimited JSON progress events out, last one carrying
{phase: "done", audio: base64 WAV, alignment}.

No existing Chatterbox wrapper (including devnen/Chatterbox-TTS-Server, which
this image's system/model setup is based on) returns word-level alignment —
that's a Phase 8 compositor concern (docs/modules/adapters.md types it as
`unknown` on our side deliberately). alignment is null here until that phase
defines the real shape.

Real progress: ChatterboxTTS.generate() is a single blocking call, but its
dominant phase (T3 autoregressive token sampling, up to 1000 steps) already
reports step counts internally via tqdm — chatterbox.models.t3.t3 imports
`tqdm` and does `for i in tqdm(range(max_new_tokens), desc="Sampling", ...)`.
We swap that module's tqdm for ProgressTqdm below (observing only, no fork of
the library's actual generation logic) and stream (step, step_limit) to the
caller. The vocoding phase after it (flow-matching + HiFi-GAN) is a fixed
~10-step ODE solve that completes in well under a second — not worth
instrumenting — so it's reported as a single indeterminate "vocoding" event,
emitted by wrapping model.s3gen.inference (the call boundary between the two
phases) rather than trying to detect sampling's last iteration, which can
exit early via an internal `break` on EOS.
"""

import base64
import io
import json
import logging
import os
import queue
import threading
import time

import soundfile as sf
import torch
from chatterbox.tts_turbo import ChatterboxTurboTTS
import chatterbox.models.t3.t3 as t3_module
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger(__name__)
device = "cuda" if torch.cuda.is_available() else "cpu"
# Turbo, not the multilingual model engines/chatterbox loads. Its diffusion
# decoder runs one step where that one runs ten, which is what makes it
# faster; its generate() is English-only and takes no language_id at all, so
# there is no language to plumb through here.
#
# Measured on gfx1151, median of three runs after warm-up, with
# MIOPEN_FIND_MODE=FAST set in the Dockerfile: RTF 0.62 against the
# multilingual model's 1.06 under the same setting, and 2.48 with neither.
# Turbo's output is markedly quieter -- peak around 0.33-0.45 against 0.83-1.0
# -- so a consumer switching between the two hears a level change.
model = ChatterboxTurboTTS.from_pretrained(device=device)
# One lock per process serializes concurrent TTS on this container. Correct for a single
# GPU with no multi-lease concept upstream (unlike LlamaRouter's roles); the lock guards only
# the blocking generate() call, not the NDJSON streaming, so progress lines still flow.
_model_lock = threading.Lock()

_progress_local = threading.local()
_SENTINEL = object()
_PROGRESS_MIN_INTERVAL_S = (
    0.1  # throttle — up to 1000 steps/request, most well under 0.1s apart
)


class ProgressTqdm:
    """Drop-in replacement for the tqdm object t3.py iterates the sampling
    loop with — reports (step, step_limit) to whichever queue the generating
    thread registered on _progress_local instead of drawing a CLI bar."""

    def __init__(self, iterable=None, total=None, **_kwargs):
        self.iterable = iterable
        self.total = (
            total
            if total is not None
            else (len(iterable) if iterable is not None else None)
        )

    def __iter__(self):
        q = getattr(_progress_local, "queue", None)
        last_emit = 0.0
        n = 0
        for item in self.iterable:
            yield item
            n += 1
            if q is not None:
                now = time.monotonic()
                if now - last_emit >= _PROGRESS_MIN_INTERVAL_S or n == self.total:
                    q.put(
                        {"phase": "synthesizing", "step": n, "step_limit": self.total}
                    )
                    last_emit = now


t3_module.tqdm = ProgressTqdm

_s3gen_inference = model.s3gen.inference


def _s3gen_inference_with_progress(*args, **kwargs):
    q = getattr(_progress_local, "queue", None)
    if q is not None:
        q.put({"phase": "vocoding"})
    return _s3gen_inference(*args, **kwargs)


model.s3gen.inference = _s3gen_inference_with_progress


class TtsRequest(BaseModel):
    text: str
    voice: str | None = None


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/v1/tts")
def synthesize(req: TtsRequest):
    q: "queue.Queue" = queue.Queue()

    def worker():
        _progress_local.queue = q
        try:
            audio_prompt = (
                req.voice if req.voice and os.path.exists(req.voice) else None
            )
            with _model_lock:
                wav = model.generate(req.text, audio_prompt_path=audio_prompt)
            buf = io.BytesIO()
            sf.write(buf, wav.squeeze(0).cpu().numpy(), model.sr, format="WAV")
            q.put(
                {
                    "phase": "done",
                    "audio": base64.b64encode(buf.getvalue()).decode("ascii"),
                    "alignment": None,
                }
            )
        # Keep expected model/encoding failures on the NDJSON stream as terminal error events.
        except (RuntimeError, ValueError) as err:
            logger.exception("Chatterbox synthesis failed")
            q.put({"phase": "error", "detail": str(err)})
        finally:
            q.put(_SENTINEL)

    threading.Thread(target=worker, daemon=True).start()

    def events():
        while True:
            item = q.get()
            if item is _SENTINEL:
                break
            yield json.dumps(item) + "\n"

    return StreamingResponse(events(), media_type="application/x-ndjson")
