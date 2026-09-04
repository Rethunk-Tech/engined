"""The half of the Chatterbox HTTP wrapper that is identical for every
Chatterbox checkpoint, built into both engines/chatterbox-en and
engines/chatterbox-multi as one file. Each image supplies only its own model
and its own generate() call and gets the whole contract from create_app().

The contract (packages/daemon/src/adapters/audio/chatterbox.ts, translated by
engined's src/audio.ts): POST /v1/tts, JSON in, newline-delimited JSON
progress events out, last one carrying {phase: "done", audio: base64 WAV,
alignment}.

No existing Chatterbox wrapper (including devnen/Chatterbox-TTS-Server, which
both images' system/model setup is based on) returns word-level alignment —
that's a compositor concern: alignment is typed `unknown` on our side
deliberately, and is null here until the shape is defined.

Real progress: generate() is a single blocking call, but its dominant phase
(T3 autoregressive token sampling, up to 1000 steps) already reports step
counts internally via tqdm — chatterbox.models.t3.t3 imports `tqdm` and does
`for i in tqdm(range(max_new_tokens), desc="Sampling", ...)`. This module
swaps that module's tqdm for ProgressTqdm (observing only, no fork of the
library's actual generation logic) and streams (step, step_limit) to the
caller. The vocoding phase after it (flow-matching + HiFi-GAN) is reported as
a single indeterminate "vocoding" event rather than per-step progress, because
s3gen.inference exposes no equivalent step hook to swap the way t3's tqdm loop
does; it is emitted by wrapping model.s3gen.inference (the call boundary
between the two phases) rather than trying to detect sampling's last
iteration, which can exit early via an internal `break` on EOS. How much of
total latency each phase costs differs per checkpoint — figures in
docs/engines.md.
"""

import base64
import io
import json
import logging
import os
import queue
import re
import threading
import time
from collections.abc import Callable

import chatterbox.models.t3.t3 as t3_module
import numpy as np
import soundfile as sf
import torch
import torchaudio
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from torchaudio.pipelines import MMS_FA

logger = logging.getLogger(__name__)
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

# One lock per process serializes concurrent TTS on this container. Correct for a single
# GPU with no multi-lease concept upstream (unlike LlamaRouter's roles); the lock guards only
# the blocking generate() call, not the NDJSON streaming, so progress lines still flow.
_model_lock = threading.Lock()

# Chatterbox exposes no alignment of its own, so the words are placed by forced
# alignment of the audio against the text that asked for it. The aligner's
# acoustic model runs on the GPU beside the voice; its alignment op is CPU-only
# in this torchaudio build, which for a sentence of audio is under 100ms.
_fa_model = MMS_FA.get_model().to(DEVICE)
_fa_tokenizer = MMS_FA.get_tokenizer()
_fa_align = MMS_FA.get_aligner()
_NOT_A_LABEL = re.compile(r"[^a-z']")


def _words(
    sample_rate: int, samples: np.ndarray, text: str, offset: float
) -> list[dict]:
    """Each word's start and end in seconds from the start of the utterance. A
    character the aligner has no label for -- a digit, an accented letter --
    becomes its wildcard, so the word is still placed rather than dropped."""
    words = text.split()
    if not words:
        return []
    wav = torchaudio.functional.resample(
        torch.from_numpy(samples.astype(np.float32)).unsqueeze(0),
        sample_rate,
        MMS_FA.sample_rate,
    ).to(DEVICE)
    with torch.inference_mode():
        emission, _ = _fa_model(wav)
    keys = [_NOT_A_LABEL.sub("*", w.lower()) for w in words]
    try:
        spans = _fa_align(emission[0].cpu(), _fa_tokenizer(keys))
    except (RuntimeError, ValueError):
        return []
    seconds_per_frame = wav.shape[1] / emission.shape[1] / MMS_FA.sample_rate
    return [
        {
            "text": word,
            "start": offset + span[0].start * seconds_per_frame,
            "end": offset + span[-1].end * seconds_per_frame,
        }
        for word, span in zip(words, spans)
    ]


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
        for n, item in enumerate(self.iterable, start=1):
            yield item
            if q is not None:
                now = time.monotonic()
                if now - last_emit >= _PROGRESS_MIN_INTERVAL_S or n == self.total:
                    q.put(
                        {"phase": "synthesizing", "step": n, "step_limit": self.total}
                    )
                    last_emit = now


t3_module.tqdm = ProgressTqdm


_SENTENCE_END = re.compile(r"(?<=[.!?…])\s+")


def _sentences(text: str) -> list[str]:
    """One generate() call per sentence when the caller streams: the first
    sentence's audio goes out while the rest is still sampling, instead of
    every sentence waiting for the last. A single-sentence request is one call
    either way, so a non-streaming caller hears exactly what it always did."""
    parts = [p.strip() for p in _SENTENCE_END.split(text.strip())]
    return [p for p in parts if p] or [text]


def _pcm16(samples: np.ndarray) -> bytes:
    """Signed 16-bit little-endian, the one encoding a streaming caller can
    concatenate without a container format in the way; clipping first keeps a
    hot sample from wrapping to the opposite sign instead of saturating."""
    return (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()


class TtsRequest(BaseModel):
    """The parameters every Chatterbox checkpoint takes. A checkpoint with
    more subclasses this and passes the subclass to create_app()."""

    text: str
    voice: str | None = None
    # Additive: an adapter that does not ask still sees exactly the frames it
    # always did. Asking adds per-sentence PCM ahead of the terminal frame.
    chunks: bool = False


def _stream(
    model,
    generate: Callable[[str, str | None, TtsRequest], torch.Tensor],
    req: TtsRequest,
) -> StreamingResponse:
    q: queue.Queue = queue.Queue()

    def worker():
        _progress_local.queue = q
        try:
            # A reference voice that does not resolve is refused rather than
            # ignored: falling back to the default voice returns confident
            # audio in the wrong voice, which no caller can distinguish from
            # a successful clone.
            if req.voice and not os.path.exists(req.voice):
                raise ValueError(
                    f"reference voice {req.voice!r} does not resolve inside this container"
                )
            audio_prompt = req.voice or None
            pieces = _sentences(req.text) if req.chunks else [req.text]
            wavs: list[np.ndarray] = []
            with _model_lock:
                for text in pieces:
                    wav = generate(text, audio_prompt, req)
                    samples = wav.squeeze(0).cpu().numpy()
                    if req.chunks:
                        q.put(
                            {
                                "phase": "chunk",
                                "pcm": base64.b64encode(_pcm16(samples)).decode(
                                    "ascii"
                                ),
                                "rate": model.sr,
                                "words": _words(
                                    model.sr,
                                    samples,
                                    text,
                                    sum(len(w) for w in wavs) / model.sr,
                                ),
                            }
                        )
                    wavs.append(samples)
            buf = io.BytesIO()
            sf.write(
                buf,
                np.concatenate(wavs) if len(wavs) > 1 else wavs[0],
                model.sr,
                format="WAV",
            )
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


def create_app(
    model,
    generate: Callable[[str, str | None, TtsRequest], torch.Tensor],
    request_model: type[TtsRequest] = TtsRequest,
) -> FastAPI:
    """The whole HTTP surface for one loaded Chatterbox model.

    `generate(text, audio_prompt, req)` is the one call that differs per
    checkpoint: it returns the audio tensor for a single piece of text.
    `request_model` is the POST body model, so a checkpoint taking extra
    parameters gets them validated and documented under its own schema.
    """
    _s3gen_inference = model.s3gen.inference

    def _s3gen_inference_with_progress(*args, **kwargs):
        q = getattr(_progress_local, "queue", None)
        if q is not None:
            q.put({"phase": "vocoding"})
        return _s3gen_inference(*args, **kwargs)

    model.s3gen.inference = _s3gen_inference_with_progress

    app = FastAPI()

    @app.get("/health")
    def health():
        return {"status": "ok"}

    # The annotation is the caller's request model rather than the base, so
    # FastAPI validates exactly the parameters this checkpoint accepts.
    @app.post("/v1/tts")
    def synthesize(req: request_model):
        return _stream(model, generate, req)

    return app
