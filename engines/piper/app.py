"""Thin HTTP wrapper around Piper for the same NDJSON /v1/tts contract chatterbox and
kokoro speak (engines/kokoro/app.py) -- not a new protocol. engined's audio door
(src/audio.ts) reads the first frame carrying a non-empty base64 `audio` field and returns
those bytes as WAV; a wrapper that served /v1/audio/speech directly would be invisible to it.

Piper is a single forward pass through a small ONNX model, with no sampling loop to
instrument -- so this emits synthesizing -> done and never step/step_limit, exactly as
kokoro's wrapper does for the same reason.

The voice is baked into the image and loaded once at import, before uvicorn binds its
listening socket. A load failure therefore kills the process rather than leaving a port
open that answers /health and fails every real request.
"""

import base64
import io
import json
import logging
import os
import queue
import threading
import wave

from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from piper import PiperVoice
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger(__name__)

VOICE_PATH = os.environ.get("PIPER_VOICE_PATH", "/app/voices/en_US-lessac-medium.onnx")
voice = PiperVoice.load(VOICE_PATH)
print(f"Piper voice loaded: {VOICE_PATH}")

_SENTINEL = object()


class TtsRequest(BaseModel):
    text: str
    # Accepted and ignored: this image bakes exactly one voice, and engined's door never
    # sends the field anyway. Declared so a caller that speaks the kokoro/chatterbox shape
    # gets a synthesis rather than a 422 over a field that would have made no difference.
    voice: str | None = None


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/v1/tts")
def synthesize(req: TtsRequest):
    q: "queue.Queue" = queue.Queue()

    def worker():
        q.put({"phase": "synthesizing"})
        try:
            buf = io.BytesIO()
            # synthesize_wav writes a complete RIFF header, so the bytes below are a
            # standalone WAV rather than raw PCM the door would have to describe.
            with wave.open(buf, "wb") as wav_file:
                voice.synthesize_wav(req.text, wav_file)
            q.put(
                {
                    "phase": "done",
                    "audio": base64.b64encode(buf.getvalue()).decode("ascii"),
                    "alignment": None,
                }
            )
        # Keep expected model/encoding failures on the NDJSON stream as terminal error
        # events, the same classes kokoro's wrapper catches.
        except (OSError, RuntimeError, ValueError) as err:
            logger.exception("Piper synthesis failed")
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
