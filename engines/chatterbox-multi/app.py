"""Chatterbox Multilingual behind the shared Chatterbox HTTP wrapper.

Everything but the checkpoint, its extra request parameters and its
generate() call lives in chatterbox_app.py, which engines/chatterbox-en
builds from too — the NDJSON /v1/tts contract, progress instrumentation,
sentence chunking and forced alignment are all defined there.
"""

from chatterbox.mtl_tts import ChatterboxMultilingualTTS
from chatterbox_app import DEVICE, TtsRequest, create_app

# Multilingual model, not the English-only ChatterboxTTS — same T3/S3Gen
# stack (confirmed: chatterbox.mtl_tts.T3 is chatterbox.models.t3.t3.T3, so
# the shared module's tqdm/s3gen progress instrumentation is unaffected), but
# .generate() takes a REQUIRED `language_id` with no default — MultilingualTtsRequest
# below defaults it to "en" so an unspecified language keeps today's output.
model = ChatterboxMultilingualTTS.from_pretrained(device=DEVICE)
DEFAULT_LANGUAGE = "en"

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


class MultilingualTtsRequest(TtsRequest):
    # ISO 639-1 code from chatterbox.mtl_tts.SUPPORTED_LANGUAGES (en, es, fr,
    # de, ja, zh, ...) — an unsupported code surfaces as a normal phase:"error"
    # event, same as any other generate() failure.
    language: str | None = None
    # Per-request because the right value is voice-dependent: a narration voice
    # can want a different setting from a short spoken reply.
    repetition_penalty: float | None = None


def _generate(text: str, audio_prompt: str | None, req: MultilingualTtsRequest):
    return model.generate(
        text,
        req.language or DEFAULT_LANGUAGE,
        audio_prompt_path=audio_prompt,
        repetition_penalty=(
            req.repetition_penalty
            if req.repetition_penalty is not None
            else DEFAULT_REPETITION_PENALTY
        ),
    )


app = create_app(model, _generate, MultilingualTtsRequest)
