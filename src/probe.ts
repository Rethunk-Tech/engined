/**
 * The acceptance probes, and the images they send.
 *
 * Each one re-proves a criterion that a response cannot signal on its own, in
 * the only place that can prove it: against the live door, on a timer, rather
 * than in a note someone has to remember to act on.
 *
 * `docs/engines.md` records the one defect in this repo that nothing in a
 * response can signal: a vision request can come back a confident, plausible,
 * WRONG description of the image. It did not reproduce across three live
 * checks, which is three data points and not a fix, and a wrong description is
 * indistinguishable from a right one without ground truth. This module is the
 * ground truth -- an image whose content is known because it was built here,
 * with an answer that can be checked.
 *
 * It lives in `src/` rather than in the local test tier because two callers
 * need the same image and the same verdict: `test/local/llama.test.ts`, which
 * drives the router directly, and `main.js --probe`, which the installed
 * timer runs against the live door. A second copy of a PNG encoder is the
 * kind of drift this repo keeps getting bitten by.
 */

import { CONTENT_TYPE, discardBody, JSON_CONTENT_TYPE, STATUS_BAD_REQUEST } from './http.ts'
import { DIGIT_GLYPHS, digitsPng, SPLIT_PNG_DATA_URI, VISION_MAX_TOKENS } from './probeImage.ts'
import { CONTRACT } from './responses.ts'
import {
  CONTENT_ENDPOINT_CHAT,
  CONTENT_ENDPOINT_COMPLETIONS,
  CONTENT_ENDPOINT_RERANK,
  CONTENT_ENDPOINT_TRANSCRIPTIONS,
  CONTENT_ENDPOINT_TRANSLATIONS,
  errMessage,
} from './types.ts'

/** The chat body that asks for exactly what `visionVerdict` reads back, and nothing else worth paying tokens for. */
export function visionRequestBody(modelId: string): string {
  return JSON.stringify({
    model: modelId,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'This image has two vertical halves. Name the color of the left half, then the color of the right half. Answer with two words.',
          },
          { type: 'image_url', image_url: { url: SPLIT_PNG_DATA_URI } },
        ],
      },
    ],
    max_tokens: VISION_MAX_TOKENS,
  })
}

/** How many digits the read probe puts in the image: long enough that a guess cannot land it, short enough to stay one glance for a reader. */
const READ_PROBE_DIGITS = 8

/** A fresh string per run, so no answer can come from having seen this image before. */
export function readProbeText(): string {
  return Array.from({ length: READ_PROBE_DIGITS }, () =>
    String(Math.floor(Math.random() * DIGIT_GLYPHS.length)),
  ).join('')
}

/** The chat body for a `read` route: the digits as an image, and an instruction with no scene in it to describe. */
function visionReadRequestBody(modelId: string, text: string): string {
  return JSON.stringify({
    model: modelId,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Read the digits in this image. Answer with the digits only.' },
          {
            type: 'image_url',
            image_url: {
              url: `data:image/png;base64,${Buffer.from(digitsPng(text)).toString('base64')}`,
            },
          },
        ],
      },
    ],
    max_tokens: READ_MAX_TOKENS,
  })
}

/** Room for the digits plus whatever framing a model insists on, and no more. */
const READ_MAX_TOKENS = 64

/** Every digit in the reply, in order, with the prose a model may wrap them in dropped. */
const NON_DIGITS = /\D+/g

/**
 * The digits, in the order they were drawn. Punctuation and framing are
 * stripped rather than rejected -- a reader that answers "The digits are
 * 4 7 1 2." read the image correctly, and failing it would be failing the
 * wrapper rather than the recognition.
 */
export function visionReadVerdict(
  expected: string,
  reply: string,
): { ok: boolean; detail: string } {
  const seen = reply.replace(NON_DIGITS, '')
  if (!seen.includes(expected)) {
    return { ok: false, detail: `expected ${expected}, read ${JSON.stringify(reply)}` }
  }
  return { ok: true, detail: `read ${expected}` }
}

/**
 * Both halves, and the order between them. Naming one colour proves the mmproj
 * path carried SOMETHING; naming both in the image's own order is the part a
 * plausible-but-wrong description cannot reach by guessing.
 */
export function visionVerdict(reply: string): { ok: boolean; detail: string } {
  const seen = reply.toLowerCase()
  const red = seen.indexOf('red')
  const blue = seen.indexOf('blue')
  if (red < 0 || blue < 0) {
    return {
      ok: false,
      detail: `named ${red < 0 ? 'no red' : 'no blue'}: ${JSON.stringify(reply)}`,
    }
  }
  if (red > blue) {
    return { ok: false, detail: `named the halves in the wrong order: ${JSON.stringify(reply)}` }
  }
  return { ok: true, detail: JSON.stringify(reply) }
}

/** How much of an error body is worth a journal line: enough to name the failure, not enough to bury it. */
const ERROR_BODY_CHARS = 200

async function postProbe(
  fetchImpl: typeof fetch,
  url: string,
  body: string,
): Promise<Response | { ok: false; detail: string }> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { [CONTENT_TYPE]: JSON_CONTENT_TYPE },
    body,
  })
  if (!res.ok) {
    return {
      ok: false,
      detail: `http ${res.status}: ${(await res.text()).slice(0, ERROR_BODY_CHARS)}`,
    }
  }
  return res
}

/** One line per vision address the door offers, in the order the menu listed them. */
interface ProbeLine {
  address: string
  ok: boolean
  detail: string
}

interface ProbeReport {
  /** False only when an address answered and got it wrong, or could not be reached at all. A door offering nothing to prove is `true` with one line saying so. */
  ok: boolean
  lines: ProbeLine[]
}

/**
 * Whether this address can answer a probe at all.
 *
 * `unavailable` is the only state worth skipping: `GET /engined/v1/engines`
 * already reports why, with the literal command that fixes it, and a probe
 * repeating that in a different voice adds nothing.
 *
 * NOT `state === "installed"`, which is what this checked first and which
 * quietly meant "prove nothing whenever the engine is already up" -- a
 * running engine reports `running`, so a box mid-use skipped every address it
 * had. That is the silence this module exists to end, so the test below pins
 * it.
 */
function canAnswer(state: unknown): boolean {
  return typeof state === 'string' && state !== 'unavailable'
}

/** The subset of a `/openai/v1/models` row this probe reads. Parsed from the wire, so it is narrowed here rather than imported: a row is whatever the running door sent, not whatever this build's `ModelRow` says. */
interface MenuRow {
  id?: unknown
  role?: unknown
  vision?: unknown
  state?: unknown
  translate?: unknown
  serves?: unknown
}

/**
 * Whether the running door is new enough for its answers to mean what this
 * probe reads them as.
 *
 * A daemon built before a field was reported answers a menu of perfectly good
 * routes without it, and a probe reading only "is any row vision?" calls that
 * "nothing to prove" and exits 0 -- the same silence this probe exists to end.
 *
 * Read from the door's own `contract` rather than guessed from whether any
 * row happens to carry a `role`. That guess was wrong for a legitimate
 * config: whisper, tts and comfy routes carry no role at all, so a box
 * serving only those looked like a stale daemon and failed weekly for a
 * defect that was not there.
 */
async function staleDoorLine(
  doorUrl: string,
  fetchImpl: typeof fetch,
): Promise<ProbeLine | undefined> {
  let contract: unknown
  try {
    const res = await fetchImpl(`${doorUrl}/engined/v1/engines`)
    if (!res.ok) {
      await discardBody(res)
      return {
        address: doorUrl,
        ok: false,
        detail: `the door answered http ${res.status} for its own engine list`,
      }
    }
    ;({ contract } = (await res.json()) as { contract?: unknown })
  } catch (err) {
    return {
      address: doorUrl,
      ok: false,
      detail: `the door could not be reached: ${errMessage(err)}`,
    }
  }
  if (contract === CONTRACT) {
    return undefined
  }
  return {
    address: doorUrl,
    ok: false,
    detail: `the running door reports contract ${String(contract)}; this probe ships with ${CONTRACT}. It predates this build -- run scripts/install.sh to bring the daemon up to the bundle this probe ships with.`,
  }
}

/**
 * Every vision address the door lists, probed in turn.
 *
 * `role` is what makes this discoverable at all -- chat and vision answer the
 * same door path, so `serves` cannot tell them apart. An address that is not
 * `installed` is left alone: `GET /engined/v1/engines` already reports why,
 * with the literal command that fixes it, and a probe repeating that in a
 * different voice adds nothing.
 *
 * A door with no vision address at all is not a failure. Nothing is
 * configured to be wrong, and the report says exactly that rather than
 * reporting a pass it did not earn.
 */
export async function runProbes(
  doorUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProbeReport> {
  let rows: MenuRow[]
  try {
    const menu = await fetchImpl(`${doorUrl}/openai/v1/models`)
    if (!menu.ok) {
      await discardBody(menu)
      return {
        ok: false,
        lines: [
          {
            address: doorUrl,
            ok: false,
            detail: `the door answered http ${menu.status} for its own model menu`,
          },
        ],
      }
    }
    const body = (await menu.json()) as { data?: MenuRow[] }
    rows = body.data ?? []
  } catch (err) {
    const message = errMessage(err)
    return {
      ok: false,
      lines: [{ address: doorUrl, ok: false, detail: `the door could not be reached: ${message}` }],
    }
  }

  const stale = await staleDoorLine(doorUrl, fetchImpl)
  if (stale !== undefined) {
    return { ok: false, lines: [stale] }
  }

  const lines = [
    ...(await probeVision(doorUrl, rows, fetchImpl)),
    ...(await probeRerank(doorUrl, rows, fetchImpl)),
    ...(await probeTranslations(doorUrl, rows, fetchImpl)),
    ...(await probeCompletions(doorUrl, rows, fetchImpl)),
  ]
  // One line for a door with nothing configured to prove, rather than one per
  // family saying the same thing: nothing here is wrong, and a report that
  // says so three times buries the one run where something is.
  if (lines.length === 0) {
    return {
      ok: true,
      lines: [{ address: doorUrl, ok: true, detail: 'no reachable address to prove' }],
    }
  }
  return { ok: lines.every((l) => l.ok), lines }
}

/** Every vision address the door lists, each sent the ground-truth check its own `vision` kind can answer. */
async function probeVision(
  doorUrl: string,
  rows: readonly MenuRow[],
  fetchImpl: typeof fetch,
): Promise<ProbeLine[]> {
  const vision = rows.filter(
    (r): r is MenuRow & { id: string } =>
      r.role === 'vision' && canAnswer(r.state) && typeof r.id === 'string',
  )
  if (vision.length === 0) {
    return []
  }

  const lines: ProbeLine[] = []
  for (const row of vision) {
    lines.push({ address: row.id, ...(await probeOne(doorUrl, row, fetchImpl)) })
  }
  return lines
}

/**
 * The rerank ground truth: one query and three documents, exactly one of
 * which answers it. A working reranker puts that one first -- results come
 * back ordered best-first, so the check is on `results[0].index`.
 *
 * Built here rather than read from a fixture for the same reason the vision
 * image is: the expected answer has to be known by construction. Measured on
 * Qwen3-Reranker-0.6B-seq-cls, the relevant document scored 0.907 against
 * 7.8e-11 and 4.9e-11, so a model that is working clears this by orders of
 * magnitude and one that is not cannot land on it by chance.
 */
const RERANK_QUERY = 'How do I stop a running container?'
const RERANK_DOCUMENTS = [
  'Bananas ripen faster when kept in a paper bag.',
  'Run docker stop followed by the container name.',
  'The Treaty of Utrecht was signed in 1713.',
]
/** The index into `RERANK_DOCUMENTS` that answers `RERANK_QUERY`. */
const RERANK_ANSWER = 1

async function probeRerank(
  doorUrl: string,
  rows: readonly MenuRow[],
  fetchImpl: typeof fetch,
): Promise<ProbeLine[]> {
  const rerank = rows.filter(
    (r): r is MenuRow & { id: string } =>
      r.role === 'rerank' && canAnswer(r.state) && typeof r.id === 'string',
  )
  if (rerank.length === 0) {
    return []
  }
  const lines: ProbeLine[] = []
  for (const row of rerank) {
    lines.push({ address: row.id, ...(await probeOneRerank(doorUrl, row.id, fetchImpl)) })
  }
  return lines
}

async function probeOneRerank(
  doorUrl: string,
  address: string,
  fetchImpl: typeof fetch,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await postProbe(
      fetchImpl,
      `${doorUrl}${CONTENT_ENDPOINT_RERANK}`,
      JSON.stringify({
        model: address,
        query: RERANK_QUERY,
        documents: RERANK_DOCUMENTS,
      }),
    )
    if (!(res instanceof Response)) {
      return res
    }
    const body = (await res.json()) as { results?: { index?: unknown }[] }
    const top = body.results?.[0]?.index
    if (typeof top !== 'number') {
      return { ok: false, detail: 'the reply carried no ranked results' }
    }
    return top === RERANK_ANSWER
      ? { ok: true, detail: `ranked the answering document first (index ${top})` }
      : {
          ok: false,
          detail: `ranked index ${top} first; the document answering the query is index ${RERANK_ANSWER}`,
        }
  } catch (err) {
    return { ok: false, detail: errMessage(err) }
  }
}

/**
 * The fill-in-the-middle ground truth: a one-line function body sits between
 * a known prefix and a known suffix, so the check is on the reply carrying
 * *any* text at all rather than on the exact tokens -- measured against the
 * resident model, the first line was correct in 3/4 runs, which is a real
 * model working, not a guessable string this probe could pin further without
 * flagging a fine daemon as broken on its off run.
 */
const FIM_PREFIX = 'def add(a, b):\n    '
const FIM_SUFFIX = '\n\nprint(add(1, 2))\n'
const FIM_MAX_TOKENS = 16

async function probeCompletions(
  doorUrl: string,
  rows: readonly MenuRow[],
  fetchImpl: typeof fetch,
): Promise<ProbeLine[]> {
  const fim = rows.filter(
    (r): r is MenuRow & { id: string } =>
      canAnswer(r.state) &&
      typeof r.id === 'string' &&
      Array.isArray(r.serves) &&
      r.serves.includes(CONTENT_ENDPOINT_COMPLETIONS),
  )
  if (fim.length === 0) {
    return []
  }
  const lines: ProbeLine[] = []
  for (const row of fim) {
    lines.push({ address: row.id, ...(await probeOneCompletion(doorUrl, row.id, fetchImpl)) })
  }
  return lines
}

async function probeOneCompletion(
  doorUrl: string,
  address: string,
  fetchImpl: typeof fetch,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await postProbe(
      fetchImpl,
      `${doorUrl}${CONTENT_ENDPOINT_COMPLETIONS}`,
      JSON.stringify({
        model: address,
        prompt: FIM_PREFIX,
        suffix: FIM_SUFFIX,
        max_tokens: FIM_MAX_TOKENS,
        stop: ['\n'],
      }),
    )
    if (!(res instanceof Response)) {
      return res
    }
    const body = (await res.json()) as { choices?: { text?: unknown }[] }
    const text = body.choices?.[0]?.text
    if (typeof text !== 'string' || text.trim() === '') {
      return { ok: false, detail: 'the reply carried no completion text' }
    }
    return { ok: true, detail: `completed: ${JSON.stringify(text)}` }
  } catch (err) {
    return { ok: false, detail: errMessage(err) }
  }
}

/**
 * The ground-truth check this route's model can actually answer.
 *
 * A `vision` role says the route takes an image; it does not say what the
 * model does with one. `describe` reads a scene back and is checked on naming
 * two colours in order; `read` recognises characters and is checked on reading
 * a freshly generated string back. Sending either check to the other model
 * fails a model that is working -- measured against PaddleOCR-VL, which
 * answers the colour question with degenerate repetition.
 */
function checkFor(row: MenuRow & { id: string }):
  | {
      body: string
      verdict: (reply: string) => { ok: boolean; detail: string }
    }
  | undefined {
  if (row.vision === 'read') {
    const text = readProbeText()
    return {
      body: visionReadRequestBody(row.id, text),
      verdict: (reply) => visionReadVerdict(text, reply),
    }
  }
  if (row.vision === 'describe') {
    return { body: visionRequestBody(row.id), verdict: visionVerdict }
  }
  // Config requires a kind on every vision route, so a row without one came
  // from a door older than that rule. Guessing here is what this whole module
  // exists to stop: the wrong guess fails a working model and reads as a
  // vision defect.
  return undefined
}

async function probeOne(
  doorUrl: string,
  row: MenuRow & { id: string },
  fetchImpl: typeof fetch,
): Promise<{ ok: boolean; detail: string }> {
  const check = checkFor(row)
  if (check === undefined) {
    return {
      ok: false,
      detail:
        'the running door reports no `vision` kind for this address, so there is no way to tell which check it can answer. It predates this probe -- run scripts/install.sh to bring the daemon up to the bundle this probe ships with.',
    }
  }
  try {
    const res = await postProbe(fetchImpl, `${doorUrl}${CONTENT_ENDPOINT_CHAT}`, check.body)
    if (!(res instanceof Response)) {
      return res
    }
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    return check.verdict(body.choices?.[0]?.message?.content ?? '')
  } catch (err) {
    return { ok: false, detail: errMessage(err) }
  }
}

/**
 * The translations guard, which is the half of that verb with a ground truth.
 *
 * Translation *quality* is deliberately not probed: unlike an image, speech
 * in a known foreign language cannot be generated in code here, so there is
 * nothing to check a translated transcript against. What can be checked is
 * the failure this door was built to prevent -- an English-only model handed
 * the translate flag does not error, it transcribes and returns something
 * that reads like a translation. So the guard is that a route which does NOT
 * declare `translate` is refused, and it is checked against every such route
 * the menu lists.
 *
 * No audio is decoded: the refusal happens at dispatch, before the upload
 * reaches an engine, so a few bytes standing in for a recording is enough and
 * the probe costs no model load at all.
 */
async function probeTranslations(
  doorUrl: string,
  rows: readonly MenuRow[],
  fetchImpl: typeof fetch,
): Promise<ProbeLine[]> {
  const englishOnly = rows.filter(
    (r): r is MenuRow & { id: string } =>
      r.role === undefined &&
      r.translate !== true &&
      canAnswer(r.state) &&
      typeof r.id === 'string' &&
      Array.isArray(r.serves) &&
      r.serves.includes(CONTENT_ENDPOINT_TRANSCRIPTIONS),
  )
  if (englishOnly.length === 0) {
    return []
  }
  const lines: ProbeLine[] = []
  for (const row of englishOnly) {
    lines.push({ address: row.id, ...(await probeOneRefusal(doorUrl, row.id, fetchImpl)) })
  }
  return lines
}

/** A few bytes standing in for a recording: enough to pass the upload check, never enough to be decoded, because the refusal lands first. */
const NOT_REALLY_AUDIO = new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0])

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
    return {
      ok: false,
      detail: `answered http ${res.status} instead of refusing to translate: ${text.slice(0, ERROR_BODY_CHARS)}`,
    }
  } catch (err) {
    return { ok: false, detail: errMessage(err) }
  }
}
