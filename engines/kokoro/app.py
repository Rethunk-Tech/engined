"""Thin HTTP wrapper around Kokoro-82M for the sagaforge AudioAdapter contract
(packages/daemon/src/adapters/audio/chatterbox.ts) — the SAME NDJSON /v1/tts contract
docker/chatterbox/app.py speaks, not a new protocol — a second TTS engine implementing this
contract reuses that adapter unmodified.

Kokoro is a single non-autoregressive forward pass — no sampling loop to instrument, unlike
Chatterbox's T3 autoregressive decode (which streams step/step_limit from tqdm). This emits
only queued -> synthesizing -> done, never step/step_limit: the daemon's audioPct already
falls back to an indeterminate bar when those fields are absent, the same path Chatterbox's
own "vocoding" phase already takes.
"""

import base64
import io
import json
import logging
import threading
import time

import numpy as np
import soundfile as sf
import torch
import torch.nn.functional as F
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from kokoro import KPipeline
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger(__name__)

# Measured on this box (gfx1151/ROCm 7.2): the vocoder (KModel.decoder) is
# the entire cost of time-to-first-audio, and that cost is not FLOPs -- it is
# MIOpen JIT-compiling a fresh kernel the first time it sees a given exact
# frame count. Repeat calls at an already-seen exact shape run in ~0.15s;
# a never-before-seen one costs ~1.1-3s regardless of how short the text is
# (confirmed: a 14-phoneme "Hi there friend" cost as much as a 71-phoneme
# sentence). Since every distinct sentence produces a distinct frame count
# (duration is predicted per phoneme, not quantized), production traffic
# hits a cold shape on nearly every request. Bucketing collapses that
# unbounded shape space to a fixed, enumerable set of frame counts so a
# one-time warm-up (below) can pre-pay the compile for the whole practical
# range, and any request's true frame count reuses whichever bucket covers it.
_DECODER_BUCKET_FRAMES = 32


class _BucketedDecoder(torch.nn.Module):
    """Rounds the vocoder's input frame count up to `_DECODER_BUCKET_FRAMES`
    with zero-padding, runs the real decoder once, then trims the output back
    to the true (unpadded) sample count.

    Correctness: verified numerically against the unpadded decoder on real
    kokoro output -- the trimmed region matches to ~1e-8 (float noise), and
    the padding-induced difference elsewhere is the same order of magnitude
    as the run-to-run noise this decoder already exhibits between two calls
    of identical input (this ROCm/MIOpen backend is not bit-deterministic
    call to call regardless of this wrapper). Padding is silence in the
    frame-rate features, not the waveform, so it does not add audible content
    of its own -- only the choice of compiled kernel changes.
    """

    def __init__(self, decoder: torch.nn.Module, bucket: int = _DECODER_BUCKET_FRAMES):
        super().__init__()
        self.decoder = decoder
        self.bucket = bucket

    def forward(
        self,
        asr: torch.Tensor,
        f0_pred: torch.Tensor,
        n_pred: torch.Tensor,
        ref: torch.Tensor,
    ) -> torch.Tensor:
        true_frames = asr.shape[-1]
        bucket_frames = -(-true_frames // self.bucket) * self.bucket
        pad = bucket_frames - true_frames
        if pad == 0:
            return self.decoder(asr, f0_pred, n_pred, ref)
        # F0/N run at a fixed multiple of the frame rate (kokoro's own
        # architecture constant) -- read it from the real tensors rather than
        # hard-coding it, so a future kokoro version that changes it still
        # pads the right amount instead of silently misaligning.
        f0_ratio = f0_pred.shape[-1] // true_frames
        n_ratio = n_pred.shape[-1] // true_frames
        asr = F.pad(asr, (0, pad))
        f0_pred = F.pad(f0_pred, (0, pad * f0_ratio))
        n_pred = F.pad(n_pred, (0, pad * n_ratio))
        out = self.decoder(asr, f0_pred, n_pred, ref)
        # Output samples are exactly linear in frame count (no fixed offset,
        # confirmed empirically) -- derive the true length from the padded
        # run's own ratio rather than assuming a hop-size constant.
        samples_per_frame = out.shape[-1] // bucket_frames
        return out[..., : true_frames * samples_per_frame]


def _warm_decoder_buckets(pipeline: KPipeline) -> None:
    """Pre-pays the bucket compile cost at container start, before /health
    (and so the readiness probe) can succeed -- same invariant the module-
    level KPipeline() construction below already relies on. Texts are chosen
    only to spread real phoneme/frame counts across the practical
    conversational range (roughly a greeting through a long sentence); their
    content is otherwise unused and never reaches a caller.
    """
    warmup_texts = [
        "Hi.",
        "Okay, sure.",
        "Got it, thanks.",
        "Let me check on that for you.",
        "The weather today looks pretty clear and mild.",
        "I found a few options that might work for what you need.",
        "That should be ready in just a moment, please hold on.",
        "Here is a longer sentence to cover replies that run past a dozen words or so.",
        "This next one is longer still, closer to a full paragraph of spoken reply text.",
        "And this final warm-up sentence pushes further out toward the longest replies this engine is likely to ever synthesize in one turn.",
    ]
    voice = "af_heart"
    t0 = time.perf_counter()
    with torch.no_grad():
        for text in warmup_texts:
            for _ in pipeline(text, voice=voice):
                pass
    # print, not logger: uvicorn's --log-level warning (see Dockerfile) would
    # otherwise swallow this, and it is the only line that says how long the
    # container spent compiling kernels before /health could answer.
    print(
        f"kokoro decoder warm-up: {len(warmup_texts)} texts in {time.perf_counter() - t0:.1f}s"
    )


pipeline = KPipeline(lang_code="a")
print(f"Kokoro pipeline resolved device: {pipeline.model.device}")
pipeline.model.decoder = _BucketedDecoder(pipeline.model.decoder)
_warm_decoder_buckets(pipeline)
SAMPLE_RATE = 24_000
# One lock per process serializes concurrent TTS on this container. Correct for a single
# GPU with no multi-lease concept upstream; the lock guards only the blocking pipeline
# call, not the NDJSON streaming.
_model_lock = threading.Lock()

# hexgrad/kokoro's own American + British English voice-pack catalog. misaki's G2P doesn't
# validate the voice id itself, so an unknown one must be rejected here rather than silently
# substituted (adapters.md MUST).
KNOWN_VOICES = {
    "af_heart",
    "af_alloy",
    "af_aoede",
    "af_bella",
    "af_jessica",
    "af_kore",
    "af_nicole",
    "af_nova",
    "af_river",
    "af_sarah",
    "af_sky",
    "am_adam",
    "am_echo",
    "am_eric",
    "am_fenrir",
    "am_liam",
    "am_michael",
    "am_onyx",
    "am_puck",
    "am_santa",
    "bf_alice",
    "bf_emma",
    "bf_isabella",
    "bf_lily",
    "bm_daniel",
    "bm_fable",
    "bm_george",
    "bm_lewis",
}


class TtsRequest(BaseModel):
    text: str
    voice: str | None = None
    # Additive: an adapter that does not ask still sees exactly the frames it
    # always did. Asking adds per-chunk PCM ahead of the terminal frame.
    chunks: bool = False


def _pcm16(samples: np.ndarray) -> bytes:
    """Signed 16-bit little-endian, the one encoding a streaming caller can
    concatenate without a container format in the way. Kokoro emits float in
    [-1, 1]; clipping first keeps a hot sample from wrapping to the opposite
    sign instead of saturating."""
    clipped = np.clip(samples, -1.0, 1.0)
    return (clipped * 32767.0).astype("<i2").tobytes()


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/v1/tts")
def synthesize(req: TtsRequest):
    voice = req.voice or "af_heart"

    def events():
        if voice not in KNOWN_VOICES:
            yield (
                json.dumps(
                    {"phase": "error", "detail": f'unknown Kokoro voice "{voice}"'}
                )
                + "\n"
            )
            return
        yield json.dumps({"phase": "synthesizing"}) + "\n"
        try:
            # The pipeline yields one array per sentence. Collecting them and
            # emitting a single WAV is what makes time-to-first-audio equal
            # time-to-last-audio; when the caller asks for chunks each one goes
            # out as it is produced, and the terminal frame still follows.
            collected = []
            with _model_lock:
                for _, _, audio in pipeline(req.text, voice=voice):
                    collected.append(audio)
                    if req.chunks:
                        yield (
                            json.dumps(
                                {
                                    "phase": "chunk",
                                    "pcm": base64.b64encode(
                                        _pcm16(np.asarray(audio))
                                    ).decode("ascii"),
                                    "rate": SAMPLE_RATE,
                                }
                            )
                            + "\n"
                        )
            chunks = collected
            wav = (
                np.asarray(chunks[0])
                if len(chunks) == 1
                else np.concatenate([np.asarray(c) for c in chunks])
            )
            buf = io.BytesIO()
            sf.write(buf, wav, SAMPLE_RATE, format="WAV")
            yield (
                json.dumps(
                    {
                        "phase": "done",
                        "audio": base64.b64encode(buf.getvalue()).decode("ascii"),
                        "alignment": None,
                    }
                )
                + "\n"
            )
        # Keep expected model/encoding failures on the NDJSON stream as terminal error events.
        except (IndexError, RuntimeError, ValueError) as err:
            logger.exception("Kokoro synthesis failed")
            yield json.dumps({"phase": "error", "detail": str(err)}) + "\n"

    return StreamingResponse(events(), media_type="application/x-ndjson")
