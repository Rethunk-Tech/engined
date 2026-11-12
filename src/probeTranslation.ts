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
import { ENGINE_ERROR_CHARS } from './http.ts'
import { canAnswer } from './probeImage.ts'
import clipPath from './probeTranslation.es.wav' with { type: 'file' }
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

interface TranslateQualityRow {
  id?: unknown
  role?: unknown
  translate?: unknown
  state?: unknown
  serves?: unknown
}

/** Every route that opted into `translate = true`, sent the clip and graded against the reference. */
export async function probeTranslationQuality(
  doorUrl: string,
  rows: readonly TranslateQualityRow[],
  fetchImpl: typeof fetch,
): Promise<{ address: string; ok: boolean; detail: string }[]> {
  const translating = rows.filter(
    (r): r is TranslateQualityRow & { id: string } =>
      r.role === undefined &&
      r.translate === true &&
      canAnswer(r.state) &&
      typeof r.id === 'string' &&
      Array.isArray(r.serves) &&
      r.serves.includes(CONTENT_ENDPOINT_TRANSCRIPTIONS) &&
      r.serves.includes(CONTENT_ENDPOINT_TRANSLATIONS),
  )
  if (translating.length === 0) {
    return []
  }
  const clip = new Uint8Array(await Bun.file(resolve(import.meta.dir, clipPath)).arrayBuffer())
  const lines: { address: string; ok: boolean; detail: string }[] = []
  for (const row of translating) {
    const form = new FormData()
    form.append('file', new Blob([clip]), 'probe.wav')
    form.append('model', row.id)
    try {
      const res = await fetchImpl(`${doorUrl}${CONTENT_ENDPOINT_TRANSLATIONS}`, {
        method: 'POST',
        body: form,
      })
      if (!res.ok) {
        lines.push({
          address: row.id,
          ok: false,
          detail: `http ${res.status}: ${(await res.text()).slice(0, ENGINE_ERROR_CHARS)}`,
        })
        continue
      }
      const { text } = (await res.json()) as { text?: unknown }
      lines.push({
        address: row.id,
        ...(typeof text === 'string'
          ? translationVerdict(TRANSLATION_REFERENCE, text)
          : { ok: false, detail: 'the reply carried no text' }),
      })
    } catch (err) {
      lines.push({ address: row.id, ok: false, detail: errMessage(err) })
    }
  }
  return lines
}
