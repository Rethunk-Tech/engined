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

import numpy as np
import soundfile as sf
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from kokoro import KPipeline
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger(__name__)
pipeline = KPipeline(lang_code="a")
print(f"Kokoro pipeline resolved device: {pipeline.model.device}")
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
