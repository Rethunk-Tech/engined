/**
 * Grades the English a `translate = true` route returns.
 *
 * The clip is Spanish speech synthesised by `scripts/gen-translation-fixture.sh`.
 * The sentence is the one on which large-v3-turbo-q8_0 was recorded returning
 * "man" for "gato" and "bed" for "mesa de madera" (engined#1), so a regression
 * of that kind fails here.
 *
 * The metric is content-word recall: the share of the reference's words, minus
 * a short stopword list, that the reply also contains (as a multiset, after
 * lowercasing and stripping punctuation). Recall rather than F1 because a
 * confidently wrong reply is fluent and the same length as the right one, so
 * overlap on the function words alone ("the", "on") carries it past an F1 bar.
 * It is deliberately crude: no stemming, so "sleeping" misses "sleeps", and the
 * pass mark leaves room for one such miss. It grades this one clip on this
 * route; it is not a general translation score.
 */

import { resolve } from 'node:path'
import { ENGINE_ERROR_CHARS, STATUS_BAD_REQUEST, STATUS_UNAVAILABLE } from './http.ts'
import clipPath from './probeTranslation.es.wav' with { type: 'file' }
import type { MenuRow } from './probeTypes.ts'
import { canAnswer, eachRow, httpProbeError, type ProbeLine } from './probeTypes.ts'
import { errMessage } from './records.ts'
import { CONTENT_ENDPOINT_TRANSCRIPTIONS, CONTENT_ENDPOINT_TRANSLATIONS } from './routeServes.ts'

export const TRANSLATION_REFERENCE = 'the black cat sleeps on the wooden table'

/** Fraction of reference content words the reply must contain. Right-but-paraphrased replies clear 0.6; the recorded wrong reply scores 0.4. */
export const TRANSLATION_PASS_RECALL = 0.6

const NON_WORD = /[^a-z0-9']+/

const STOPWORDS = new Set(['a', 'an', 'the', 'on', 'in', 'at', 'of', 'to', 'is', 'are'])

function contentWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(NON_WORD)
    .filter((w) => w !== '' && !STOPWORDS.has(w))
}

/** Content-word recall of `reply` against `reference`, each reference word matched at most as often as the reply repeats it. */
export function translationRecall(reference: string, reply: string): number {
  const want = contentWords(reference)
  if (want.length === 0) {
    return 0
  }
  const have = new Map<string, number>()
  for (const w of contentWords(reply)) {
    have.set(w, (have.get(w) ?? 0) + 1)
  }
  let hit = 0
  for (const w of want) {
    const left = have.get(w) ?? 0
    if (left > 0) {
      hit += 1
      have.set(w, left - 1)
    }
  }
  return hit / want.length
}

export function translationVerdict(
  reference: string,
  reply: string,
): { ok: boolean; detail: string } {
  const recall = translationRecall(reference, reply)
  const ok = recall >= TRANSLATION_PASS_RECALL
  return {
    ok,
    detail: `${ok ? 'translated' : 'mistranslated'}: content-word recall ${recall.toFixed(2)} (pass at ${TRANSLATION_PASS_RECALL}) for ${JSON.stringify(reply.trim().slice(0, ENGINE_ERROR_CHARS))}; reference ${JSON.stringify(reference)}`,
  }
}

const RIFF_ASCII_R = 0x52
const RIFF_ASCII_I = 0x49
const RIFF_ASCII_F = 0x46
const RIFF_WAVEFORM_SIZE_PLACEHOLDER = 0
const NOT_REALLY_AUDIO = new Uint8Array([
  RIFF_ASCII_R,
  RIFF_ASCII_I,
  RIFF_ASCII_F,
  RIFF_ASCII_F,
  RIFF_WAVEFORM_SIZE_PLACEHOLDER,
  RIFF_WAVEFORM_SIZE_PLACEHOLDER,
  RIFF_WAVEFORM_SIZE_PLACEHOLDER,
  RIFF_WAVEFORM_SIZE_PLACEHOLDER,
])

/** Every route that opted into `translate = true`, sent the clip and graded against the reference. */
export function probeTranslationQuality(
  doorUrl: string,
  rows: readonly MenuRow[],
  fetchImpl: typeof fetch,
): Promise<ProbeLine[]> {
  let clip: Uint8Array | undefined
  return eachRow(
    rows,
    (r) =>
      r.role === undefined &&
      r.translate === true &&
      canAnswer(r.state) &&
      Array.isArray(r.serves) &&
      r.serves.includes(CONTENT_ENDPOINT_TRANSCRIPTIONS) &&
      r.serves.includes(CONTENT_ENDPOINT_TRANSLATIONS),
    async (row) => {
      clip ??= new Uint8Array(await Bun.file(resolve(import.meta.dir, clipPath)).arrayBuffer())
      const form = new FormData()
      form.append('file', new Blob([clip]), 'probe.wav')
      form.append('model', row.id)
      try {
        const res = await fetchImpl(`${doorUrl}${CONTENT_ENDPOINT_TRANSLATIONS}`, {
          method: 'POST',
          body: form,
        })
        if (!res.ok) {
          return httpProbeError(res.status, await res.text())
        }
        const { text } = (await res.json()) as { text?: unknown }
        return typeof text === 'string'
          ? translationVerdict(TRANSLATION_REFERENCE, text)
          : { ok: false, detail: 'the reply carried no text' }
      } catch (err) {
        return { ok: false, detail: errMessage(err) }
      }
    },
  )
}

async function probeOneRefusal(
  doorUrl: string,
  address: string,
  fetchImpl: typeof fetch,
): Promise<{ ok: boolean; detail: string }> {
  const form = new FormData()
  form.append('file', new Blob([NOT_REALLY_AUDIO]), 'probe.wav')
  form.append('model', address)
  try {
    const res = await fetchImpl(`${doorUrl}${CONTENT_ENDPOINT_TRANSLATIONS}`, {
      method: 'POST',
      body: form,
    })
    const text = await res.text()
    if (res.status === STATUS_BAD_REQUEST) {
      return { ok: true, detail: 'refused to translate, as a route not declaring it must' }
    }
    if (res.status === STATUS_UNAVAILABLE) {
      return httpProbeError(res.status, text)
    }
    return {
      ok: false,
      detail: `answered http ${res.status} instead of refusing to translate: ${text.slice(0, ENGINE_ERROR_CHARS)}`,
    }
  } catch (err) {
    return { ok: false, detail: errMessage(err) }
  }
}

/** English-only transcription routes must refuse `/translations` before any model loads. */
export function probeTranslations(
  doorUrl: string,
  rows: readonly MenuRow[],
  fetchImpl: typeof fetch,
): Promise<ProbeLine[]> {
  return eachRow(
    rows,
    (r) =>
      r.role === undefined &&
      r.translate !== true &&
      canAnswer(r.state) &&
      Array.isArray(r.serves) &&
      r.serves.includes(CONTENT_ENDPOINT_TRANSCRIPTIONS),
    (row) => probeOneRefusal(doorUrl, row.id, fetchImpl),
  )
}
