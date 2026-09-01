"""Thin HTTP wrapper around chatterbox-tts for the sagaforge AudioAdapter
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
caller. The vocoding phase after it (flow-matching + HiFi-GAN) measures on
the order of one second on this hardware (gfx1151, with MIOPEN_FIND_MODE=FAST
set in the Dockerfile) — a share of total latency comparable to sampling
itself, not a negligible tail. It's still reported as a single indeterminate
"vocoding" event rather than per-step progress, because s3gen.inference
exposes no equivalent step hook to swap the way t3's tqdm loop does; it's
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
from chatterbox.mtl_tts import ChatterboxMultilingualTTS
import chatterbox.models.t3.t3 as t3_module
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger(__name__)
device = "cuda" if torch.cuda.is_available() else "cpu"
# Multilingual model, not the English-only ChatterboxTTS — same T3/S3Gen
# stack (confirmed: chatterbox.mtl_tts.T3 is chatterbox.models.t3.t3.T3, so
# the tqdm/s3gen progress instrumentation below is unaffected), but
# .generate() takes a REQUIRED `language_id` with no default — TtsRequest
# below defaults it to "en" so an unspecified language keeps today's output.
model = ChatterboxMultilingualTTS.from_pretrained(device=device)
DEFAULT_LANGUAGE = "en"
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


# ChatterboxMultilingualTTS.generate() defaults this to 2.0, which is high
# enough to push T3 into repeating tokens: sampling then ends only when the
# library's alignment analyzer force-stops it ("forcing EOS token ...
# token_repetition=True"), and how many steps that takes is what makes the
# duration erratic.
#
# The pathology is short input only. Six runs each, seconds of audio:
#
#             123-char phrase          8-char phrase
#   rp=2.0    6.00  (5.68-6.32)        2.72  (0.80-9.88)
#   rp=1.5    5.62  (5.44-6.04)        0.92  (0.76-1.20)
#   rp=1.2    5.40  (5.16-5.80)        0.72  (0.60-0.92)
#
# A long phrase is stable at every setting -- it has enough content to reach a
# natural stop before repetition sets in. A short one at 2.0 spans 12x.
#
# 1.5 rather than T3.inference's own 1.2 because the long phrase is the
# control: at 1.5 it lands within 6% of what 2.0 produces, where 1.2 shortens
# it 10%. Both fix the short-phrase tail, so the tie-break is which one leaves
# the already-approved voice alone.
DEFAULT_REPETITION_PENALTY = 1.5


class TtsRequest(BaseModel):
    text: str
    voice: str | None = None
    # ISO 639-1 code from chatterbox.mtl_tts.SUPPORTED_LANGUAGES (en, es, fr,
    # de, ja, zh, ...) — an unsupported code surfaces as a normal phase:"error"
    # event via the except below, same as any other generate() failure.
    language: str | None = None
    # Per-request because the right value is voice-dependent: a narration voice
    # can want a different setting from a short spoken reply.
    repetition_penalty: float | None = None


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
                wav = model.generate(
                    req.text,
                    req.language or DEFAULT_LANGUAGE,
                    audio_prompt_path=audio_prompt,
                    repetition_penalty=(
                        req.repetition_penalty
                        if req.repetition_penalty is not None
                        else DEFAULT_REPETITION_PENALTY
                    ),
                )
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
