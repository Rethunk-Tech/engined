"""Thin HTTP wrapper around Piper for the same NDJSON /v1/tts contract the chatterbox
engines and kokoro speak (engines/kokoro/app.py) -- not a new protocol. engined's audio door
(src/audio.ts) reads the first frame carrying a non-empty base64 `audio` field and returns
those bytes as WAV; a wrapper that served /v1/audio/speech directly would be invisible to it.

Piper is a single forward pass per sentence, with no sampling loop to instrument -- so this
emits synthesizing -> done and never step/step_limit, exactly as kokoro's wrapper does for
the same reason. A caller asking for `chunks` additionally gets one `chunk` frame per
sentence as it lands, carrying that sentence's PCM and the voice's own sample rate: the door
has no other channel to learn the rate on, because raw PCM has no container to put it in.

The voice is baked into the image and loaded once at import, before uvicorn binds its
listening socket. A load failure therefore kills the process rather than leaving a port
open that answers /health and fails every real request.
"""

import base64
import io
import json
import logging
import os
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
# One lock per process serializes concurrent TTS on this container. Correct for a single
# GPU with no multi-lease concept upstream; the lock guards only the blocking synthesis
# call, not the NDJSON streaming.
_model_lock = threading.Lock()


class TtsRequest(BaseModel):
    text: str
    # Accepted and ignored: this image bakes exactly one voice, and engined's door never
    # sends the field anyway. Declared so a caller that speaks the kokoro/chatterbox shape
    # gets a synthesis rather than a 422 over a field that would have made no difference.
    voice: str | None = None
    # Additive: a caller that does not ask still sees exactly the frames it always did.
    # Asking adds per-sentence PCM ahead of the terminal frame.
    chunks: bool = False


# Piper's phoneme string marks a word gap with a space and a sentence with ^ and $.
_GAPS = {" ", "^", "$"}


def _phoneme_counts(texts: list[str]) -> list[int]:
    """How many phonemes each of the caller's words is, phonemized alone. The
    sentence's own phoneme string is no use for this: espeak drops the gap
    between some pairs ("from the" is one run) and expands "1980" to several,
    so runs and words do not line up -- but the phonemes themselves do."""
    return [
        sum(
            len([p for p in sentence if p not in _GAPS])
            for sentence in voice.phonemize(text)
        )
        for text in texts
    ]


def _words(chunk, offset: int, texts: list[str], counts: list[int]) -> list[dict]:
    """Each word's start and end in seconds from the start of the utterance: the
    per-phoneme sample counts the patched voice reports, walked in the caller's
    words by `counts`. Nothing when the counts do not add up to the sentence's
    phonemes, because a guess would put a caller's mark in the wrong place."""
    phones: list[tuple[int, int]] = []
    at = offset
    for alignment in chunk.phoneme_alignments or []:
        end = at + int(alignment.num_samples)
        if alignment.phoneme not in _GAPS:
            phones.append((at, end))
        at = end
    if sum(counts) != len(phones):
        return []
    rate = chunk.sample_rate
    words = []
    i = 0
    for text, n in zip(texts, counts):
        if n > 0:
            words.append(
                {
                    "text": text,
                    "start": phones[i][0] / rate,
                    "end": phones[i + n - 1][1] / rate,
                }
            )
        i += n
    return words


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/v1/tts")
def synthesize(req: TtsRequest):
    def events():
        yield json.dumps({"phase": "synthesizing"}) + "\n"
        try:
            # One AudioChunk per sentence. Collecting them and emitting a single WAV is
            # what makes time-to-first-audio equal time-to-last-audio; when the caller asks
            # for chunks each one goes out as it is produced, and the terminal frame still
            # follows.
            pcm = bytearray()
            fmt = None
            # Words are only attributable when the whole request is one sentence:
            # piper's chunks carry no text of their own to split the caller's against.
            texts = req.text.split() if len(voice.phonemize(req.text)) == 1 else []
            counts = _phoneme_counts(texts)
            with _model_lock:
                for chunk in voice.synthesize(req.text, include_alignments=True):
                    fmt = (chunk.sample_channels, chunk.sample_width, chunk.sample_rate)
                    if req.chunks:
                        yield (
                            json.dumps(
                                {
                                    "phase": "chunk",
                                    "pcm": base64.b64encode(
                                        chunk.audio_int16_bytes
                                    ).decode("ascii"),
                                    "rate": chunk.sample_rate,
                                    "words": _words(
                                        chunk, len(pcm) // 2, texts, counts
                                    ),
                                }
                            )
                            + "\n"
                        )
                    pcm += chunk.audio_int16_bytes
            if fmt is None:
                # Text that phonemizes to nothing -- punctuation alone, say. There is no
                # format to write a WAV header with, and a zero-length WAV would read to
                # the caller as a successful silent synthesis.
                yield (
                    json.dumps({"phase": "error", "detail": "text produced no audio"})
                    + "\n"
                )
                return
            channels, width, rate = fmt
            buf = io.BytesIO()
            # A complete RIFF header, so the bytes below are a standalone WAV rather than
            # raw PCM the door would have to describe.
            with wave.open(buf, "wb") as wav_file:
                wav_file.setnchannels(channels)
                wav_file.setsampwidth(width)
                wav_file.setframerate(rate)
                wav_file.writeframes(pcm)
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
        # Keep expected model/encoding failures on the NDJSON stream as terminal error
        # events, the same classes kokoro's wrapper catches.
        except (OSError, RuntimeError, ValueError) as err:
            logger.exception("Piper synthesis failed")
            # The trace stays in the container log; the caller gets the class, not the message.
            detail = f"synthesis failed ({type(err).__name__}); see the engine log"
            yield json.dumps({"phase": "error", "detail": detail}) + "\n"

    return StreamingResponse(events(), media_type="application/x-ndjson")
