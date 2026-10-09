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

import { CONTENT_TYPE, discardBody, ENGINE_ERROR_CHARS, JSON_CONTENT_TYPE } from './http.ts'
import {
  probeTranslations,
  readProbeText,
  visionReadRequestBody,
  visionReadVerdict,
  visionRequestBody,
  visionVerdict,
} from './probeImage.ts'
import { errMessage } from './records.ts'
import { CONTRACT } from './responses.ts'
import {
  CONTENT_ENDPOINT_CHAT,
  CONTENT_ENDPOINT_COMPLETIONS,
  CONTENT_ENDPOINT_RERANK,
  OPENAI_MODELS_PATH,
} from './routeServes.ts'
import { ENGINED_ENGINES_PATH } from './usage.ts'

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
      detail: `http ${res.status}: ${(await res.text()).slice(0, ENGINE_ERROR_CHARS)}`,
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
    const res = await fetchImpl(`${doorUrl}${ENGINED_ENGINES_PATH}`)
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
    const menu = await fetchImpl(`${doorUrl}${OPENAI_MODELS_PATH}`)
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
 * image is: the expected answer has to be known by construction. A working
 * reranker clears this by orders of magnitude and a broken one cannot land on
 * it by chance.
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
 * *any* text at all rather than on the exact tokens -- a real model's first
 * line is not always the same, so pinning it further would flag a fine daemon
 * as broken on its off run.
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
 * fails a model that is working -- PaddleOCR-VL
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
