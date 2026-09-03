"""Chatterbox Turbo behind the shared Chatterbox HTTP wrapper.

Everything but the checkpoint and its generate() call lives in
chatterbox_app.py, which engines/chatterbox-multi builds from too — the
NDJSON /v1/tts contract, progress instrumentation, sentence chunking and
forced alignment are all defined there.
"""

from chatterbox.tts_turbo import ChatterboxTurboTTS
from chatterbox_app import DEVICE, TtsRequest, create_app

# Turbo, not the multilingual model engines/chatterbox-multi loads. Its diffusion
# decoder runs one step where that one runs ten, which is what makes it
# faster; its generate() is English-only and takes no language_id at all, so
# there is no language to plumb through here.
#
# Turbo sets norm_loudness=True where the multilingual model does not, so its
# output is markedly quieter and a consumer switching between the two hears a
# level change. Throughput and loudness figures: docs/engines.md.
model = ChatterboxTurboTTS.from_pretrained(device=DEVICE)


def _generate(text: str, audio_prompt: str | None, _req: TtsRequest):
    return model.generate(text, audio_prompt_path=audio_prompt)


app = create_app(model, _generate)
