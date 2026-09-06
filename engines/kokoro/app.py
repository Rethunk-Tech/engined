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
import types

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
# What this does NOT cover, measured rather than assumed: the modules ahead of
# the vocoder -- bert, predictor.text_encoder, predictor.lstm, F0Ntrain -- key
# their own compiled kernels on the INPUT phoneme count, which this wrapper
# never touches. A never-before-seen input length costs ~1.1s over a repeat of
# the same one (0.61s vs 0.20s at 36 chars, 1.61s vs 0.52s at 185), flat across
# lengths, and it recurs once per container life.
#
# Two cheaper fixes were tried and do not work. The MIOpen cache volume below
# does NOT amortize it: after a restart the same shape costs 1.585s again
# against 0.527s warm, so the cost is per-process, not per-disk-cache. And a
# startup sweep cannot cover the space -- roughly 400 distinct phoneme counts
# at ~1.1s each is ~7 minutes on EVERY start, against a 120s ready timeout.

_DECODER_BUCKET_FRAMES = 32
# bert's self-attention and KModel.text_encoder's CNN stack are the two
# modules a padded, correctly-masked `input_ids` can genuinely fix: both are
# non-recurrent over the token axis, so padding to a fixed bucket with
# per-position masking is the standard, exact (not approximate) transformer
# padding trick -- unlike the decoder's zero-pad-and-trim, no correctness
# margin is spent here at all. 16 tokens keeps the padding waste small against
# the ~2-140 phoneme range the warm-up below already spans.
_INPUT_ID_BUCKET = 16


@torch.no_grad()
def _padded_forward_with_tokens(self, input_ids, ref_s, speed=1):
    """Replaces `KModel.forward_with_tokens` (kokoro 0.9.4) so `self.bert` and
    `self.text_encoder` see one padded shape per `_INPUT_ID_BUCKET` bucket
    instead of one per exact phoneme count, the same JIT-bucketing this file
    already does for the decoder.

    Reimplemented rather than wrapped: the original derives `input_lengths`
    from `input_ids.shape[-1]`, so simply padding the tensor before calling it
    would leave `text_mask` masking nothing and let the pad tokens draw real
    durations (`duration_proj` clamps min=1) and generate audible frames. This
    version keeps `input_lengths` at the true, pre-pad count for every masked
    or packed step, and forces the padded tail's predicted duration to exactly
    0 (never the clamped-to-1 original) so `pred_aln_trg` -- and therefore
    every frame the decoder ever sees -- is built only from real phonemes.

    `self.predictor.lstm` is the one call in the original this does NOT
    bucket: it is bidirectional and un-packed, so its backward pass starts at
    the sequence's last step and would run across the padded tail before
    reaching real content, changing the real positions' predicted durations
    depending on how much padding follows them -- a correctness break, not a
    speed tradeoff. Packing it to the true length here avoids that at the
    cost of leaving its own shape (and therefore its own JIT cost) exactly as
    variable as before. `F0Ntrain` has the identical bidirectional-LSTM shape
    (`self.shared`) and is left untouched for the same reason: bucketing it
    safely means reimplementing it with the same packing fix, which is a
    separate change with its own correctness pass, not a padding tweak.
    """
    true_len = input_ids.shape[-1]
    bucket_len = -(-true_len // _INPUT_ID_BUCKET) * _INPUT_ID_BUCKET
    pad = bucket_len - true_len
    if pad:
        # Token id 0 is kokoro's own boundary token -- KModel.forward already
        # wraps every input as [0, *ids, 0], so this reuses an id the vocab
        # already treats as content-free rather than inventing a new one.
        input_ids = F.pad(input_ids, (0, pad), value=0)

    input_lengths = torch.full(
        (input_ids.shape[0],), true_len, device=input_ids.device, dtype=torch.long
    )
    text_mask = (
        torch.arange(input_ids.shape[-1])
        .unsqueeze(0)
        .expand(input_ids.shape[0], -1)
        .type_as(input_lengths)
    )
    text_mask = torch.gt(text_mask + 1, input_lengths.unsqueeze(1)).to(self.device)
    bert_dur = self.bert(input_ids, attention_mask=(~text_mask).int())
    d_en = self.bert_encoder(bert_dur).transpose(-1, -2)
    s = ref_s[:, 128:]
    d = self.predictor.text_encoder(d_en, s, input_lengths, text_mask)

    # See docstring: pack to the true length so the backward LSTM pass never
    # runs across the zero-padded tail before reaching real positions.
    packed = torch.nn.utils.rnn.pack_padded_sequence(
        d, [true_len], batch_first=True, enforce_sorted=False
    )
    self.predictor.lstm.flatten_parameters()
    packed_out, _ = self.predictor.lstm(packed)
    x, _ = torch.nn.utils.rnn.pad_packed_sequence(
        packed_out, batch_first=True, total_length=true_len
    )
    duration = self.predictor.duration_proj(x)
    duration = torch.sigmoid(duration).sum(axis=-1) / speed
    pred_dur_true = torch.round(duration).clamp(min=1).long().squeeze(0)
    pred_dur = (
        torch.cat(
            [
                pred_dur_true,
                torch.zeros(
                    pad, dtype=pred_dur_true.dtype, device=pred_dur_true.device
                ),
            ]
        )
        if pad
        else pred_dur_true
    )

    indices = torch.repeat_interleave(
        torch.arange(input_ids.shape[1], device=self.device), pred_dur
    )
    pred_aln_trg = torch.zeros(
        (input_ids.shape[1], indices.shape[0]), device=self.device
    )
    pred_aln_trg[indices, torch.arange(indices.shape[0])] = 1
    pred_aln_trg = pred_aln_trg.unsqueeze(0).to(self.device)
    en = d.transpose(-1, -2) @ pred_aln_trg
    # Untouched: en's frame count is sum(pred_dur), driven by real phoneme
    # content, not by input_ids' padded length -- F0Ntrain gets no bucketing
    # benefit or penalty from this function either way. See docstring.
    F0_pred, N_pred = self.predictor.F0Ntrain(en, s)
    t_en = self.text_encoder(input_ids, input_lengths, text_mask)
    asr = t_en @ pred_aln_trg
    audio = self.decoder(asr, F0_pred, N_pred, ref_s[:, :128]).squeeze()
    # join_timestamps (kokoro/pipeline.py) indexes pred_dur per real token and
    # expects exactly bos+phonemes+eos entries -- the bucket tail must not
    # reach it.
    return audio, pred_dur_true


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
pipeline.model.forward_with_tokens = types.MethodType(
    _padded_forward_with_tokens, pipeline.model
)
# The warm-up loop below drives every call through the patched
# forward_with_tokens too, so it pre-pays both the decoder's frame buckets and
# the input-id buckets in the same pass -- no separate sweep needed.
_warm_decoder_buckets(pipeline)
SAMPLE_RATE = 24_000
# One lock per process serializes concurrent TTS on this container. Correct for a single
# GPU with no multi-lease concept upstream; the lock guards only the blocking pipeline
# call, not the NDJSON streaming.
_model_lock = threading.Lock()

# hexgrad/kokoro's own American + British English voice-pack catalog. misaki's G2P doesn't
# validate the voice id itself, so an unknown one must be rejected here rather than silently
# substituted.
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


def _seconds(chunks: list[np.ndarray]) -> float:
    return sum(len(c) for c in chunks) / SAMPLE_RATE


def _words(result, offset: float) -> list[dict]:
    """Each spoken word with its start and end in seconds from the start of
    the whole utterance. The English G2P times every token; punctuation and
    whitespace tokens are not words and are left out, so a caller can cut the
    text it sent at the word that was playing."""
    return [
        {"text": t.text, "start": offset + t.start_ts, "end": offset + t.end_ts}
        for t in (getattr(result, "tokens", None) or [])
        if t.start_ts is not None
        and t.end_ts is not None
        and any(c.isalnum() for c in t.text)
    ]


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
                for result in pipeline(req.text, voice=voice):
                    audio = np.asarray(result.audio)
                    if req.chunks:
                        yield (
                            json.dumps(
                                {
                                    "phase": "chunk",
                                    "pcm": base64.b64encode(_pcm16(audio)).decode(
                                        "ascii"
                                    ),
                                    "rate": SAMPLE_RATE,
                                    "words": _words(result, _seconds(collected)),
                                }
                            )
                            + "\n"
                        )
                    collected.append(audio)
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
