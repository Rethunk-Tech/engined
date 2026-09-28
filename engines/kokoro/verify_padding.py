"""Standalone correctness check for app.py's `_padded_forward_with_tokens`
input-id bucketing patch. Not a suite: this is the one runnable check the
patch leaves behind, per the same discipline `_BucketedDecoder`'s own
docstring documents for the decoder-side bucketing it already ships.

Compares three things per text: two UNPATCHED pipelines against each other
(the `control` column -- this box's own call-to-call ROCm/MIOpen noise floor,
with no padding involved at all) and an unpatched pipeline against a patched
one (the `padded` column). The tolerance is not a fixed constant: it is
`CONTROL_MARGIN` times whatever the control column measures for that same
text in the same run, because the control noise itself grows with input
length (measured: 0.066/0.078/0.15 absolute across the three lengths below,
on this box) -- a fixed number calibrated at one length under- or
over-tolerates at another.

This file is not baked into the image. Bind-mount it and set PYTHONPATH so
`app` and `kokoro` import from /app:

  docker run --rm \\
    -e PYTHONPATH=/app \\
    -v "$PWD/engines/kokoro/verify_padding.py:/app/verify_padding.py:ro" \\
    --entrypoint python3 engined-kokoro:local \\
    /app/verify_padding.py
"""

import types

import numpy as np
import torch
from app import _padded_forward_with_tokens
from kokoro import KPipeline

TEXTS = [
    "Hi.",
    "Let me check on that for you, one moment please.",
    "This next one is longer still, closer to a full paragraph of spoken "
    "reply text, meant to exercise a large input-id bucket end to end.",
]
VOICE = "af_heart"
# Same order of magnitude as the decoder's own established bar (padding-
# induced difference no worse than this backend's already-present noise) --
# 3x rather than 1x because the patch adds two more numerically-sensitive
# modules (bert's attention, the packed predictor.lstm) between the input and
# the samples being compared, each with its own share of that same kind of
# noise.
CONTROL_MARGIN = 3.0


def synth(pipeline: KPipeline, text: str) -> np.ndarray:
    for result in pipeline(text, voice=VOICE):
        return np.asarray(result.audio)
    raise RuntimeError(f"no output for {text!r}")


def compare(a: np.ndarray, b: np.ndarray) -> tuple[int, float, float]:
    n = min(len(a), len(b))
    diff = np.abs(a[:n] - b[:n])
    return abs(len(a) - len(b)), float(diff.max()), float(diff.mean())


def main() -> int:
    baseline = KPipeline(lang_code="a")
    control = KPipeline(lang_code="a")
    padded = KPipeline(lang_code="a")
    padded.model.forward_with_tokens = types.MethodType(
        _padded_forward_with_tokens, padded.model
    )

    failed = False
    with torch.no_grad():
        for text in TEXTS:
            a = synth(baseline, text)
            c = synth(control, text)
            b = synth(padded, text)

            c_samples, c_max, c_mean = compare(a, c)
            p_samples, p_max, p_mean = compare(a, b)
            limit = c_max * CONTROL_MARGIN
            ok = p_samples <= c_samples + 600 and p_max <= limit
            failed = failed or not ok
            print(
                f"{text[:40]!r:42} "
                f"control(max={c_max:.4f} mean={c_mean:.5f} sample_diff={c_samples}) "
                f"padded(max={p_max:.4f} mean={p_mean:.5f} sample_diff={p_samples}) "
                f"limit={limit:.4f} {'OK' if ok else 'FAIL'}"
            )
    if failed:
        print(
            f"FAIL: padded diverged past {CONTROL_MARGIN}x this run's own control noise"
        )
        return 1
    print(
        f"OK: every text's padded/unpadded diff stayed within {CONTROL_MARGIN}x this run's own control noise"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
