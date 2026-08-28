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
            chunks = [audio for _, _, audio in pipeline(req.text, voice=voice)]
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
